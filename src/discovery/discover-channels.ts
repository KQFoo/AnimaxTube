import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase } from '../db/index.ts';
import { DISCOVERY_SEARCH_QUERIES, SEED_CHANNELS, type SeedChannelSpec } from './channel-registry.ts';
import { upsertChannel, verifyChannelHasFreeAnimeSeries } from './add-channel.ts';
import {
  fetchChannelByHandle,
  fetchChannelsByIds,
  getSessionQuotaUnits,
  searchChannels,
  type YtChannelInfo,
} from '../lib/youtube.ts';

const SKIP_CHANNEL_SEARCH = process.argv.includes('--seed-only');
const AUTO_APPROVE_SEARCH = process.argv.includes('--auto-approve-search');

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

export async function runDiscovery() {
  const db = openDatabase();
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
        isVerified: true,
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
      const existingStatusStmt = db.prepare(
        'SELECT discovery_source, is_verified FROM channels WHERE youtube_channel_id = ? LIMIT 1'
      );
      const infos = await fetchChannelsByIds(candidateIds);
      for (const info of infos) {
        if (seenIds.has(info.id)) continue;
        seenIds.add(info.id);
        const existing = existingStatusStmt.get(info.id) as
          | { discovery_source: string; is_verified: number }
          | undefined;
        if (existing && (existing.is_verified === 1 || existing.discovery_source === 'rejected')) {
          continue;
        }
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
            discoverySource: AUTO_APPROVE_SEARCH ? 'search' : 'search_pending',
            isVerified: AUTO_APPROVE_SEARCH,
            playlistCount: check.playlistCount,
          });
          console.log(
            `  [${AUTO_APPROVE_SEARCH ? 'discovered' : 'queued-pending'}] ${info.title} (${info.id}) — ${check.playlistCount} playlists [${check.subLanguages.join(', ')}]`
          );
        } catch (err) {
          console.warn(`  [warn] Candidate verification failed for ${info.title}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('last_discovery_at', unixepoch()) ON CONFLICT(key) DO UPDATE SET dirty = unixepoch()"
    ).run();
  }

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM channels WHERE is_verified = 1').get() as { cnt: number };
  const pending = db
    .prepare("SELECT COUNT(*) AS cnt FROM channels WHERE is_verified = 0 AND discovery_source = 'search_pending'")
    .get() as { cnt: number };
  console.log(
    `\nDiscovery complete: ${total.cnt} verified channels (${pending.cnt} pending review). YouTube quota used: ~${getSessionQuotaUnits()} units.`
  );
  closeDatabase();
}

const isDirect =
  Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  runDiscovery().catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
