import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../db/index.ts';
import type { ChannelRow } from '../db/schema.ts';
import {
  fetchAllPlaylists,
  fetchChannelByHandle,
  fetchChannelsByIds,
  fetchPlaylistItems,
  getSessionQuotaUnits,
  type YtChannelInfo,
} from '../lib/youtube.ts';
import { detectSubLanguage, extractEpisodeNumber, isNonSeriesPlaylist } from '../ingestion/title-parser.ts';
import { SEED_CHANNELS, type SeedChannelSpec } from './channel-registry.ts';

export type ChannelCategory = 'anime' | 'donghua' | 'studio';
export type SubLangHint = 'en' | 'zh-Hant' | 'zh-Hans';

export interface ParsedChannelInput {
  channelId?: string;
  handle?: string;
}

export interface ChannelVerificationResult {
  ok: boolean;
  playlistCount: number;
  qualifyingPlaylists: number;
  subLanguages: string[];
}

export interface UpsertChannelInput {
  info: YtChannelInfo;
  handle: string | null;
  category: ChannelCategory;
  regionFocus: string;
  subLanguages: string[];
  discoverySource: string;
  isVerified: boolean;
  playlistCount: number;
}

export interface AddChannelOptions {
  category?: ChannelCategory;
  regionFocus?: string;
  subLanguages?: SubLangHint[];
  discoverySource?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface AddChannelResult {
  ok: boolean;
  reason?: string;
  channelId: number | null;
  youtubeChannelId: string;
  name: string;
  handle: string | null;
  url: string;
  playlistCount: number;
  qualifyingPlaylists: number;
  subLanguages: string[];
}

const ANIME_SIGNAL_RE =
  /anime|donghua|episode|ep\s*\d+|eng\s*sub|中文字幕|繁中|簡中|正版|動畫|動漫|番劇|木棉花|muse|ani-one|gundam|bilibili|tencent|youku|iqiyi|remow|tms|retrocrush|crunchyroll/i;

const NON_CHANNEL_SEGMENTS = new Set(['watch', 'playlist', 'shorts', 'feed', 'results', 'channel', 'live']);

export function parseChannelInput(raw: string): ParsedChannelInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^UC[\w-]{10,}$/.test(trimmed)) {
    return { channelId: trimmed };
  }

  const maybeUrl =
    /^https?:\/\//i.test(trimmed) || /^(?:www\.|m\.)?youtube\.com\//i.test(trimmed)
      ? /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`
      : null;

  if (maybeUrl) {
    try {
      const parsedUrl = new URL(maybeUrl);
      const hostname = parsedUrl.hostname.toLowerCase();
      if (!hostname.endsWith('youtube.com')) return null;

      const segments = parsedUrl.pathname
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean);
      if (segments.length === 0) return null;

      if (segments[0] === 'channel' && segments[1] && /^UC[\w-]{10,}$/.test(segments[1])) {
        return { channelId: segments[1] };
      }
      if (segments[0].startsWith('@') && segments[0].length > 1) {
        return { handle: `@${decodeURIComponent(segments[0].slice(1))}` };
      }
      if ((segments[0] === 'c' || segments[0] === 'user') && segments[1]) {
        return { handle: `@${decodeURIComponent(segments[1])}` };
      }
      if (!NON_CHANNEL_SEGMENTS.has(segments[0].toLowerCase())) {
        return { handle: `@${decodeURIComponent(segments[0])}` };
      }
      return null;
    } catch {
      return null;
    }
  }

  const noQuery = trimmed.split(/[/?#]/)[0].trim();
  if (!noQuery) return null;
  if (/^UC[\w-]{10,}$/.test(noQuery)) {
    return { channelId: noQuery };
  }
  const cleanHandle = noQuery.startsWith('@') ? noQuery : `@${noQuery}`;
  if (!/^@[a-zA-Z0-9._\-\u0080-\uffff]{2,}$/.test(cleanHandle)) return null;
  return { handle: cleanHandle };
}

export async function verifyChannelHasFreeAnimeSeries(
  info: YtChannelInfo,
  langHint: SubLangHint,
  isSeeded: boolean,
  opts: { force?: boolean } = {}
): Promise<ChannelVerificationResult> {
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
    } else if (/sub\s*indo|indo\s*sub|bahasa|ซับไทย|vietsub|thuyết minh/i.test(p.title)) {
      otherLangCount++;
    } else if (isSeeded) {
      langs.add(langHint);
    }
  }

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

  const hasPlaylists = isSeeded
    ? seriesPlaylists.length >= 1 || episodeUploadHits >= 3
    : seriesPlaylists.length >= 3 && langs.size > 0 && otherLangCount < seriesPlaylists.length / 2;

  const ok =
    Boolean(opts.force) ||
    (hasPlaylists &&
      (langs.size > 0 || (isSeeded && ANIME_SIGNAL_RE.test(`${info.title} ${info.description}`))));

  return {
    ok,
    playlistCount: playlists.length,
    qualifyingPlaylists: seriesPlaylists.length,
    subLanguages: langs.size > 0 ? [...langs] : [langHint],
  };
}

export function upsertChannel(db: DatabaseSync, data: UpsertChannelInput): number {
  const handle = data.handle || data.info.customUrl || null;
  const url = handle
    ? `https://www.youtube.com/${handle.startsWith('@') ? handle : `@${handle}`}`
    : `https://www.youtube.com/channel/${data.info.id}`;

  db.prepare(
    `INSERT INTO channels (
      youtube_channel_id, handle, name, url, avatar_url, description,
      uploads_playlist_id, region_focus, sub_languages, category,
      discovery_source, is_verified, playlist_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      discovery_source = CASE
        WHEN channels.discovery_source = 'manual' AND excluded.discovery_source != 'manual' THEN 'manual'
        WHEN excluded.discovery_source = 'search_pending' AND channels.discovery_source IN ('search', 'registry', 'rejected') THEN channels.discovery_source
        ELSE excluded.discovery_source
      END,
      is_verified = CASE
        WHEN excluded.discovery_source = 'manual' THEN excluded.is_verified
        WHEN channels.discovery_source = 'manual' THEN 1
        WHEN channels.discovery_source = 'rejected' AND excluded.discovery_source = 'search_pending' THEN 0
        WHEN channels.is_verified = 1 AND excluded.is_verified = 0 THEN 1
        ELSE excluded.is_verified
      END`
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
    data.isVerified ? 1 : 0,
    data.playlistCount
  );

  const row = db
    .prepare('SELECT id FROM channels WHERE youtube_channel_id = ? LIMIT 1')
    .get(data.info.id) as { id: number };
  return row.id;
}

export async function resolveYouTubeChannel(parsed: ParsedChannelInput): Promise<YtChannelInfo | null> {
  if (parsed.channelId) {
    const items = await fetchChannelsByIds([parsed.channelId]);
    return items[0] || null;
  }
  if (parsed.handle) {
    return fetchChannelByHandle(parsed.handle);
  }
  return null;
}

function inferCategory(info: YtChannelInfo, requested?: ChannelCategory): ChannelCategory {
  if (requested) return requested;
  return /bilibili|tencent|youku|iqiyi|donghua/i.test(`${info.title} ${info.description}`) ? 'donghua' : 'anime';
}

export async function addOrUpdateSingleChannel(
  db: DatabaseSync,
  rawInput: string,
  opts: AddChannelOptions = {}
): Promise<AddChannelResult> {
  const parsed = parseChannelInput(rawInput);
  if (!parsed) {
    throw new Error(`Invalid channel URL, @handle, or UC... channel ID: "${rawInput}"`);
  }

  const info = await resolveYouTubeChannel(parsed);
  if (!info) {
    throw new Error(`YouTube channel not found for "${rawInput}"`);
  }

  const langHint: SubLangHint = opts.subLanguages?.[0] || 'en';
  const check = await verifyChannelHasFreeAnimeSeries(info, langHint, true, { force: opts.force });
  const mergedLangs = [...new Set([...(opts.subLanguages || []), ...check.subLanguages])];
  const handle = parsed.handle || info.customUrl || null;
  const url = handle
    ? `https://www.youtube.com/${handle.startsWith('@') ? handle : `@${handle}`}`
    : `https://www.youtube.com/channel/${info.id}`;

  if (!check.ok) {
    return {
      ok: false,
      reason: 'No qualifying EN/ZH series playlists or numbered episode uploads found (pass force=true to override).',
      channelId: null,
      youtubeChannelId: info.id,
      name: info.title,
      handle,
      url,
      playlistCount: check.playlistCount,
      qualifyingPlaylists: check.qualifyingPlaylists,
      subLanguages: mergedLangs,
    };
  }

  const category = inferCategory(info, opts.category);
  const regionFocus =
    opts.regionFocus?.trim() || (mergedLangs.some((l) => l.startsWith('zh')) ? 'Asia / Global' : 'Global');

  if (opts.dryRun) {
    return {
      ok: true,
      channelId: null,
      youtubeChannelId: info.id,
      name: info.title,
      handle,
      url,
      playlistCount: check.playlistCount,
      qualifyingPlaylists: check.qualifyingPlaylists,
      subLanguages: mergedLangs,
    };
  }

  const channelId = upsertChannel(db, {
    info,
    handle,
    category,
    regionFocus,
    subLanguages: mergedLangs,
    discoverySource: opts.discoverySource || 'manual',
    isVerified: true,
    playlistCount: check.playlistCount,
  });

  return {
    ok: true,
    channelId,
    youtubeChannelId: info.id,
    name: info.title,
    handle,
    url,
    playlistCount: check.playlistCount,
    qualifyingPlaylists: check.qualifyingPlaylists,
    subLanguages: mergedLangs,
  };
}

export interface ReconcileDeps {
  seeds?: SeedChannelSpec[];
  resolveIds?: (ids: string[]) => Promise<YtChannelInfo[]>;
  resolveHandle?: (handle: string) => Promise<YtChannelInfo | null>;
  verifyChannel?: (
    info: YtChannelInfo,
    langHint: SubLangHint,
    isSeeded: boolean
  ) => Promise<ChannelVerificationResult>;
}

/**
 * Registers any `SEED_CHANNELS` entries that do not yet exist in `channels`.
 * Uses 0 YouTube quota units when the database already contains every registry entry.
 */
export async function reconcileMissingSeedChannels(db: DatabaseSync, deps: ReconcileDeps = {}): Promise<number> {
  const seeds = deps.seeds || SEED_CHANNELS;
  const existingRows = db
    .prepare('SELECT youtube_channel_id, handle FROM channels')
    .all() as unknown as Array<{ youtube_channel_id: string; handle: string | null }>;

  const knownIds = new Set(existingRows.map((r) => r.youtube_channel_id));
  const knownHandles = new Set(
    existingRows
      .map((r) => r.handle?.trim().toLowerCase())
      .filter((h): h is string => Boolean(h))
  );

  const missing = seeds.filter((spec) => {
    if (spec.channelId && knownIds.has(spec.channelId)) return false;
    if (spec.handle && knownHandles.has(spec.handle.trim().toLowerCase())) return false;
    return true;
  });

  if (missing.length === 0) return 0;

  const resolveIds = deps.resolveIds || fetchChannelsByIds;
  const resolveHandle = deps.resolveHandle || fetchChannelByHandle;
  const verifyChannel = deps.verifyChannel || verifyChannelHasFreeAnimeSeries;

  console.log(`Reconciling ${missing.length} new curated registry channel(s) into database...`);
  const directIds = missing.map((m) => m.channelId).filter((id): id is string => Boolean(id));
  const idMap = new Map<string, YtChannelInfo>();
  if (directIds.length > 0) {
    const infos = await resolveIds(directIds);
    for (const info of infos) idMap.set(info.id, info);
  }

  let added = 0;
  for (const spec of missing) {
    try {
      let info: YtChannelInfo | null = spec.channelId ? idMap.get(spec.channelId) || null : null;
      if (!info && spec.handle) {
        info = await resolveHandle(spec.handle);
      }
      if (!info || knownIds.has(info.id)) continue;

      const check = await verifyChannel(info, spec.defaultSubLanguages[0], true);
      if (!check.ok) {
        console.log(`  [skip-empty] ${info.title} (${info.id}) has no qualifying series playlists.`);
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
      knownIds.add(info.id);
      if (spec.handle) knownHandles.add(spec.handle.toLowerCase());
      added++;
      console.log(`  [reconciled] ${info.title} (${info.id}) — ${check.playlistCount} playlists`);
    } catch (err) {
      console.warn(`  [warn] Failed reconciling ${spec.name}:`, err instanceof Error ? err.message : err);
    }
  }
  return added;
}

async function runCli() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const noSync = args.includes('--no-sync');
  const categoryArg = args.find((a) => a.startsWith('--category='))?.split('=')[1];
  const regionArg = args.find((a) => a.startsWith('--region='))?.split('=').slice(1).join('=');
  const langsArg = args.find((a) => a.startsWith('--langs='))?.split('=')[1];
  const target = args.find((a) => !a.startsWith('--'));

  if (!target) {
    console.error(
      'Usage: npm run channel:add -- <@handle|UC...|youtube_url> [--category=anime|donghua|studio] [--region="Global"] [--langs=en,zh-Hant] [--force] [--no-sync] [--dry-run]'
    );
    process.exit(1);
  }

  const category =
    categoryArg === 'anime' || categoryArg === 'donghua' || categoryArg === 'studio' ? categoryArg : undefined;
  const subLanguages = langsArg
    ? (langsArg
        .split(',')
        .map((l) => l.trim())
        .filter((l): l is SubLangHint => l === 'en' || l === 'zh-Hant' || l === 'zh-Hans'))
    : undefined;

  const db = openDatabase();
  try {
    const result = await addOrUpdateSingleChannel(db, target, {
      category,
      regionFocus: regionArg,
      subLanguages: subLanguages && subLanguages.length > 0 ? subLanguages : undefined,
      force,
      dryRun,
    });

    if (!result.ok) {
      console.error(`[rejected] ${result.name} (${result.youtubeChannelId}): ${result.reason}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `${dryRun ? '[dry-run]' : '[added]'} ${result.name} (${result.youtubeChannelId}) | ${result.handle || result.url} | ${result.qualifyingPlaylists}/${result.playlistCount} qualifying playlists [${result.subLanguages.join(', ')}]`
    );

    if (!dryRun && !noSync && result.channelId !== null) {
      const channelRow = db
        .prepare('SELECT * FROM channels WHERE id = ?')
        .get(result.channelId) as unknown as ChannelRow | undefined;
      if (channelRow) {
        const { syncChannel } = await import('../ingestion/sync-channels.ts');
        await syncChannel(db, channelRow);
      }
    }

    console.log(`YouTube quota used: ~${getSessionQuotaUnits()} units.`);
  } finally {
    closeDatabase();
  }
}

const isDirect =
  Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  runCli().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    closeDatabase();
    process.exit(1);
  });
}
