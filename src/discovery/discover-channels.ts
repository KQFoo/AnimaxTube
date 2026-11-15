import 'dotenv/config';
import { openDatabase, closeDatabase } from '../db/index.ts';
import { DISCOVERY_SEARCH_QUERIES, SEED_CHANNELS, type SeedChannelSpec } from './channel-registry.ts';
import {
  fetchAllPlaylists,
  fetchChannelByHandle,
  fetchChannelsByIds,
  fetchPlaylistItems,
  getSessionQuotaUnits,
  searchChannels,
  type YtChannelInfo,
} from '../lib/youtube.ts';
import { detectSubLanguage, extractEpisodeNumber, isNonSeriesPlaylist } from '../ingestion/title-parser.ts';

const SKIP_CHANNEL_SEARCH = process.argv.includes('--seed-only');

const EXCLUDED_KEYWORDS = [
  'amv',
  'gmv',
  'reaction',
  'reacts',
  'review',
  'recap',
  'explained',
  'summary',
  'cover',
  'nightcore',
  'edit',
  'edits',
  'shorts',
  'gameplay',
  '短剧',
  '短劇',
  'short drama',
  'indonesia',
  'thailand',
  'vietnam',
];

const SPAM_CHANNEL_RE = /views\s*•|hours?\s*ago|days?\s*ago|短剧|短劇|劇場$/i;

const ANIME_SIGNAL_RE =
  /anime|donghua|episode|ep\s*\d+|eng\s*sub|中文字幕|繁中|簡中|正版|動畫|動漫|番劇|木棉花|muse|ani-one|gundam|bilibili|tencent|youku|iqiyi|remow|tms|retrocrush|crunchyroll/i;

function looksLikeNonEpisodeChannel(title: string, description: string): boolean {
  if (SPAM_CHANNEL_RE.test(title)) return true;
  const combined = `${title} ${description}`.toLowerCase();
  // Keep if it strongly matches official anime distribution signals (except Indonesian/Thai/Viet localized branches)
  if (
    /muse|ani-one|ani-mi|tropics anime|itsanime|remow|gundaminfo|madebybilibili|tms official|retrocrush|nozomi|crunchyroll|木棉花|羚邦/i.test(
      combined
    ) &&
    !/indonesia|thailand|vietnam/i.test(title)
  ) {
    return false;
  }
  const hasExcluded = EXCLUDED_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`, 'i').test(combined));
  return hasExcluded;
}

async function verifyChannelHasFreeAnimeSeries(
  info: YtChannelInfo,
  langHint: 'en' | 'zh-Hant' | 'zh-Hans',
  isSeeded: boolean
): Promise<{ ok: boolean; playlistCount: number; subLanguages: string[] }> {
  const playlists = await fetchAllPlaylists(info.id, 3);
  const seriesPlaylists = playlists.filter((p) => p.itemCount >= 2 && !isNonSeriesPlaylist(p.title));
  const langs = new Set<string>();
  let otherLangCount = 0;

  for (const p of seriesPlaylists.slice(0, 30)) {
    const lang = detectSubLanguage(p.title, 'other');
    if (lang === 'en' || lang === 'zh-Hant' || lang === 'zh-Hans') {
      langs.add(lang);
    } else if (lang === 'multi') {
      langs.add('en');
      langs.add(langHint.startsWith('zh') ? langHint : 'zh-Hant');
    } else {
      // Check if title contains explicit Indonesian/Malay/Thai/Viet markers
      if (/sub\s*indo|indo\s*sub|bahasa|ซับไทย|vietsub|thuyết minh/i.test(p.title)) {
        otherLangCount++;
      } else if (isSeeded) {
        langs.add(langHint);
      }
    }
  }

  // Also check recent uploads if playlist signal is weak (only for seeded or playlist-bearing channels)
  let episodeUploadHits = 0;
  if (seriesPlaylists.length === 0 && isSeeded && info.uploadsPlaylistId) {
    const uploads = await fetchPlaylistItems(info.uploadsPlaylistId, 1);
    for (const item of uploads.slice(0, 30)) {
      if (extractEpisodeNumber(item.title) !== null) {
        episodeUploadHits++;
        const lang = detectSubLanguage(item.title, langHint);
        if (lang === 'en' || lang === 'zh-Hant' || lang === 'zh-Hans') {
          langs.add(lang);
        }
      }
    }
  }

  // Require at least 2 qualifying playlists for search-discovered channels (prevents spam/empty channels)
  const hasPlaylists = isSeeded
    ? seriesPlaylists.length >= 1 || episodeUploadHits >= 3
    : seriesPlaylists.length >= 3 && langs.size > 0 && otherLangCount < seriesPlaylists.length / 2;

  const ok =
    hasPlaylists &&
    (langs.size > 0 || (isSeeded && ANIME_SIGNAL_RE.test(`${info.title} ${info.description}`)));

  return {
    ok,
    playlistCount: playlists.length,
    subLanguages: langs.size > 0 ? [...langs] : [langHint],
  };
}

function upsertChannel(
  db: ReturnType<typeof openDatabase>,
  data: {
    info: YtChannelInfo;
    handle: string | null;
    category: 'anime' | 'donghua' | 'studio';
    regionFocus: string;
    subLanguages: string[];
    discoverySource: string;
    playlistCount: number;
  }
) {
  const handle = data.handle || data.info.customUrl || null;
  const url = handle
    ? `https://www.youtube.com/${handle.startsWith('@') ? handle : `@${handle}`}`
    : `https://www.youtube.com/channel/${data.info.id}`;

  db.prepare(
    `INSERT INTO channels (
      youtube_channel_id, handle, name, url, avatar_url, description,
      uploads_playlist_id, region_focus, sub_languages, category,
      discovery_source, is_verified, playlist_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(youtube_channel_id) DO UPDATE SET
      handle = COALESCE(excluded.handle, channels.handle),
      name = excluded.name,
      url = excluded.url,
      avatar_url = COALESCE(excluded.avatar_url, channels.avatar_url),
      description = excluded.description,
      uploads_playlist_id = COALESCE(excluded.uploads_playlist_id, channels.uploads_playlist_id),
      region_focus = COALESCE(excluded.region_focus, channels.region_focus),
      sub_languages = excluded.sub_languages,
      category = excluded.category,
      playlist_count = excluded.playlist_count,
      is_verified = 1`
  ).run(
    data.info.id,
    handle,
    data.info.title,
    url,
    data.info.avatarUrl,
    data.info.description.slice(0, 500),
    data.info.uploadsPlaylistId,
    data.regionFocus,
    JSON.stringify([...new Set(data.subLanguages)]),
    data.category,
    data.discoverySource,
    data.playlistCount
  );
}

export async function runDiscovery() {
  const db = openDatabase();
  // Reset verification flag before re-evaluating so stale non-EN/ZH or spam channels drop cleanly
  db.exec('UPDATE channels SET is_verified = 0');
  const seenIds = new Set<string>();
  const resolvedSeeds: Array<{ spec: SeedChannelSpec; info: YtChannelInfo }> = [];

  console.log(`Resolving ${SEED_CHANNELS.length} curated free-anime channel handles/IDs...`);
  const directIds = SEED_CHANNELS.filter((s) => s.channelId).map((s) => s.channelId!);
  const directMap = new Map<string, YtChannelInfo>();
  if (directIds.length > 0) {
    const infos = await fetchChannelsByIds(directIds);
    for (const info of infos) directMap.set(info.id, info);
  }

  for (const spec of SEED_CHANNELS) {
    try {
      let info: YtChannelInfo | null = spec.channelId ? directMap.get(spec.channelId) || null : null;
      if (!info && spec.handle) {
        info = await fetchChannelByHandle(spec.handle);
      }
      if (!info) {
        console.warn(`  [miss] Could not resolve ${spec.name} (${spec.handle || spec.channelId})`);
        continue;
      }
      if (seenIds.has(info.id)) continue;
      seenIds.add(info.id);
      resolvedSeeds.push({ spec, info });
    } catch (err) {
      console.warn(`  [warn] Failed resolving ${spec.name}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Resolved ${resolvedSeeds.length} curated channels. Verifying series playlists...`);
  for (const { spec, info } of resolvedSeeds) {
    try {
      const check = await verifyChannelHasFreeAnimeSeries(info, spec.defaultSubLanguages[0], true);
      if (!check.ok) {
        console.log(`  [skip-empty] ${info.title} (${info.id}) has no qualifying series playlists/episodes.`);
        continue;
      }
      const mergedLangs = [...new Set([...spec.defaultSubLanguages, ...check.subLanguages])];
      upsertChannel(db, {
        info,
        handle: spec.handle || info.customUrl,
        category: spec.category,
        regionFocus: spec.regionFocus,
        subLanguages: mergedLangs,
        discoverySource: 'registry',
        playlistCount: check.playlistCount,
      });
      console.log(`  [ok] ${info.title} (${info.id}) — ${check.playlistCount} playlists [${mergedLangs.join(', ')}]`);
    } catch (err) {
      console.warn(`  [warn] Verification error for ${info.title}:`, err instanceof Error ? err.message : err);
    }
  }

  if (!SKIP_CHANNEL_SEARCH) {
    console.log(`\nRunning live YouTube channel search discovery (${DISCOVERY_SEARCH_QUERIES.length} queries)...`);
    const candidateMap = new Map<string, { langHint: 'en' | 'zh-Hant' | 'zh-Hans'; title: string; description: string }>();

    for (const q of DISCOVERY_SEARCH_QUERIES) {
      try {
        const hits = await searchChannels(q.query, 15);
        for (const hit of hits) {
          if (seenIds.has(hit.channelId) || candidateMap.has(hit.channelId)) continue;
          if (looksLikeNonEpisodeChannel(hit.title, hit.description)) continue;
          if (!ANIME_SIGNAL_RE.test(`${hit.title} ${hit.description}`)) continue;
          candidateMap.set(hit.channelId, {
            langHint: q.langHint,
            title: hit.title,
            description: hit.description,
          });
        }
      } catch (err) {
        console.warn(`  [warn] Search "${q.query}" failed:`, err instanceof Error ? err.message : err);
      }
    }

    const candidateIds = [...candidateMap.keys()];
    if (candidateIds.length > 0) {
      console.log(`Evaluating ${candidateIds.length} newly discovered candidate channels...`);
      const infos = await fetchChannelsByIds(candidateIds);
      for (const info of infos) {
        if (seenIds.has(info.id)) continue;
        seenIds.add(info.id);
        const hint = candidateMap.get(info.id)?.langHint || 'en';
        try {
          const check = await verifyChannelHasFreeAnimeSeries(info, hint, false);
          if (!check.ok) continue;
          upsertChannel(db, {
            info,
            handle: info.customUrl,
            category: /bilibili|tencent|youku|iqiyi|donghua/i.test(info.title) ? 'donghua' : 'anime',
            regionFocus: hint.startsWith('zh') ? 'TW/HK/Global' : 'Global/Asia',
            subLanguages: check.subLanguages,
            discoverySource: 'search',
            playlistCount: check.playlistCount,
          });
          console.log(`  [discovered] ${info.title} (${info.id}) — ${check.playlistCount} playlists [${check.subLanguages.join(', ')}]`);
        } catch (err) {
          console.warn(`  [warn] Candidate verification failed for ${info.title}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM channels WHERE is_verified = 1').get() as { cnt: number };
  console.log(`\nDiscovery complete: ${total.cnt} verified channels stored. YouTube quota used: ~${getSessionQuotaUnits()} units.`);
  closeDatabase();
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('discover-channels.ts');
if (isDirect) {
  runDiscovery().catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
