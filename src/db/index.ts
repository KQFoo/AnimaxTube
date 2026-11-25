import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  SCHEMA_SQL,
  type ChannelRow,
  type ChannelSeriesRow,
  type EpisodeRow,
  type LiveStreamRow,
  type SeriesRow,
  type SongRow,
} from './schema.ts';
import {
  getNextQuotaResetUnix,
  getYouTubeApiKeys,
  getYouTubeQuotaDayKey,
  setQuotaRecorder,
} from '../lib/youtube.ts';

let cachedDb: DatabaseSync | null = null;
let cachedPath: string | null = null;

export function getDbPath(): string {
  const raw = process.env.DB_PATH;
  if (raw === ':memory:') return ':memory:';
  return path.resolve(raw || path.join(process.cwd(), 'data', 'animaxtube.db'));
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function migrateExistingSchema(db: DatabaseSync): void {
  // Series new metadata columns
  ensureColumn(db, 'series', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'series', 'total_views', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'series', 'total_likes', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'series', 'total_comments', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'series', 'latest_uploaded_at', 'INTEGER');
  ensureColumn(db, 'series', 'buzz_score', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'series', 'buzz_tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'series', 'top_comment_quote', 'TEXT');
  ensureColumn(db, 'series', 'top_comment_author', 'TEXT');
  ensureColumn(db, 'series', 'top_comment_likes', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'series', 'buzz_scored_at', 'INTEGER');
  ensureColumn(db, 'series', 'unlocked_at', 'INTEGER');
  ensureColumn(db, 'series', 'expires_at', 'INTEGER');

  // Episodes new metadata columns
  ensureColumn(db, 'episodes', 'description', 'TEXT');
  ensureColumn(db, 'episodes', 'view_count', 'INTEGER');
  ensureColumn(db, 'episodes', 'like_count', 'INTEGER');
  ensureColumn(db, 'episodes', 'comment_count', 'INTEGER');
  ensureColumn(db, 'episodes', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'episodes', 'details_synced_at', 'INTEGER');
  ensureColumn(db, 'episodes', 'unlocked_at', 'INTEGER');
  ensureColumn(db, 'episodes', 'expires_at', 'INTEGER');

  // Channel sync preference columns
  ensureColumn(db, 'channels', 'sync_playlists', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'channels', 'sync_videos', 'INTEGER NOT NULL DEFAULT 1');

  // Channel series incremental sync tracking
  ensureColumn(db, 'channel_series', 'playlist_item_count', 'INTEGER');

  // Live streams geo metadata columns
  ensureColumn(db, 'live_streams', 'region_allowed', 'TEXT');
  ensureColumn(db, 'live_streams', 'region_blocked', 'TEXT');

  // Ensure FTS5 includes `tags` column (recreate if older 6-col FTS exists)
  const ftsCols = db.prepare('PRAGMA table_info(series_fts)').all() as unknown as Array<{ name: string }>;
  if (ftsCols.length > 0 && !ftsCols.some((c) => c.name === 'tags')) {
    db.exec('DROP TABLE series_fts;');
    db.exec(`
      CREATE VIRTUAL TABLE series_fts USING fts5(
        series_id UNINDEXED,
        canonical_title,
        title_en,
        title_zh,
        title_romaji,
        channel_names,
        tags
      );
    `);
  }
}

export function openDatabase(dbPath = getDbPath()): DatabaseSync {
  if (cachedDb && cachedPath === dbPath) return cachedDb;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // Migrate pre-existing columns before running indexes in SCHEMA_SQL
  const hasSeries = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='series'")
    .get();
  if (hasSeries) {
    migrateExistingSchema(db);
  }
  db.exec(SCHEMA_SQL);
  cachedDb = db;
  cachedPath = dbPath;
  setQuotaRecorder((units) => recordYouTubeQuotaUnits(db, units));
  return db;
}

export function closeDatabase(): void {
  setQuotaRecorder(null);
  channelGeoCache.clear();
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
    cachedPath = null;
  }
}

export interface YouTubeQuotaStatus {
  dayKey: string;
  keyCount: number;
  perKeyLimit: number;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  resetAt: number;
}

export function recordYouTubeQuotaUnits(db: DatabaseSync, units: number, now = new Date()): void {
  if (!Number.isFinite(units) || units <= 0) return;
  const key = `yt_quota_used:${getYouTubeQuotaDayKey(now)}`;
  db.prepare(
    'INSERT INTO cache_flags (key, dirty) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET dirty = dirty + excluded.dirty'
  ).run(key, Math.round(units));
}

export function getYouTubeQuotaStatus(db: DatabaseSync, now = new Date()): YouTubeQuotaStatus {
  let keyCount = 0;
  try {
    keyCount = getYouTubeApiKeys().length;
  } catch {
    keyCount = 0;
  }
  const perKeyLimit = Math.max(1000, parseInt(process.env.YOUTUBE_DAILY_QUOTA_PER_KEY || '10000', 10) || 10000);
  const dailyLimit = keyCount * perKeyLimit;
  const dayKey = getYouTubeQuotaDayKey(now);
  const row = db
    .prepare('SELECT dirty FROM cache_flags WHERE key = ? LIMIT 1')
    .get(`yt_quota_used:${dayKey}`) as { dirty: number } | undefined;
  const usedToday = Math.max(0, row?.dirty || 0);
  return {
    dayKey,
    keyCount,
    perKeyLimit,
    dailyLimit,
    usedToday,
    remaining: Math.max(0, dailyLimit - usedToday),
    resetAt: getNextQuotaResetUnix(now),
  };
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

const regionDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });
const MAX_CACHED_REGIONS = 40;

export function normalizeRegionCode(region?: string | null): string | null {
  if (!region) return null;
  const clean = region.trim().toUpperCase();
  if (!clean || clean === 'ALL' || clean === 'GLOBAL' || clean === 'ZZ' || !/^[A-Z]{2}$/.test(clean)) {
    return null;
  }
  const label = regionDisplayNames.of(clean);
  if (!label || label === clean || label === 'Unknown Region') {
    return null;
  }
  return clean;
}

const channelGeoCache = new Map<string, { blockedChannelIds: number[]; expiresAt: number }>();

function getBlockedUnsyncedChannelIds(db: DatabaseSync, region: string): number[] {
  const now = Date.now();
  const cached = channelGeoCache.get(region);
  if (cached && cachedPath !== ':memory:' && cached.expiresAt > now) {
    return cached.blockedChannelIds;
  }

  const pattern = `%"${region}"%`;
  const rows = db
    .prepare(
      `SELECT e.channel_id,
              SUM(CASE WHEN e.details_synced_at IS NOT NULL OR e.region_allowed IS NOT NULL OR e.region_blocked IS NOT NULL THEN 1 ELSE 0 END) AS synced_cnt,
              SUM(CASE WHEN (e.details_synced_at IS NOT NULL OR e.region_allowed IS NOT NULL OR e.region_blocked IS NOT NULL)
                        AND (e.region_allowed IS NULL OR e.region_allowed = '[]' OR e.region_allowed LIKE ?)
                        AND (e.region_blocked IS NULL OR e.region_blocked = '[]' OR e.region_blocked NOT LIKE ?)
                  THEN 1 ELSE 0 END) AS ok_cnt
       FROM episodes e
       WHERE e.is_members_only = 0
       GROUP BY e.channel_id`
    )
    .all(pattern, pattern) as unknown as Array<{ channel_id: number; synced_cnt: number; ok_cnt: number }>;

  const blockedChannelIds = rows
    .filter((r) => {
      if (r.synced_cnt === 0) return false;
      if (r.ok_cnt === 0) return true;
      return r.synced_cnt >= 20 && r.ok_cnt / r.synced_cnt < 0.02;
    })
    .map((r) => r.channel_id);

  if (cachedPath !== ':memory:') {
    channelGeoCache.set(region, { blockedChannelIds, expiresAt: now + 60_000 });
  }
  return blockedChannelIds;
}

/**
 * Builds an O(1)-per-row SQL predicate asserting episode `<alias>` is playable in `<region>`.
 */
export function ensureSeriesTagsIndexed(db: DatabaseSync): void {
  const flag = db
    .prepare("SELECT dirty FROM cache_flags WHERE key = 'tags'")
    .get() as { dirty: number } | undefined;
  if (flag && flag.dirty === 0) return;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec('DELETE FROM series_tags;');
    const rows = db
      .prepare("SELECT id, genres, tags FROM series WHERE tags != '[]' OR genres != '[]'")
      .all() as unknown as Array<{ id: number; genres: string; tags: string }>;
    const insertStmt = db.prepare('INSERT OR IGNORE INTO series_tags (tag, series_id) VALUES (?, ?)');
    for (const r of rows) {
      const seen = new Set<string>();
      for (const raw of [...parseJsonArray(r.tags), ...parseJsonArray(r.genres)]) {
        const t = raw.trim().toLowerCase();
        if (t && !seen.has(t)) {
          seen.add(t);
          insertStmt.run(t, r.id);
        }
      }
    }
    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('tags', 0) ON CONFLICT(key) DO UPDATE SET dirty = 0"
    ).run();
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export function ensureRegionCache(db: DatabaseSync, region: string): void {
  const dirtyFlag = db
    .prepare("SELECT dirty FROM cache_flags WHERE key = 'regions'")
    .get() as { dirty: number } | undefined;

  if (dirtyFlag && dirtyFlag.dirty === 1) {
    channelGeoCache.clear();
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(
        'DELETE FROM region_cache_meta; DELETE FROM region_series_cache; DELETE FROM region_cs_cache; DELETE FROM region_channel_cache;'
      );
      db.prepare(
        "INSERT INTO cache_flags (key, dirty) VALUES ('regions', 0) ON CONFLICT(key) DO UPDATE SET dirty = 0"
      ).run();
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  } else {
    const existing = db
      .prepare('SELECT 1 FROM region_cache_meta WHERE region = ? LIMIT 1')
      .get(region);
    if (existing) return;
  }

  const geoE = buildEpisodeGeoSql(db, 'e', region);
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(
      `INSERT OR REPLACE INTO region_cs_cache (region, channel_series_id, series_id, channel_id, sub_language, episode_count)
       SELECT ?, cs.id, cs.series_id, cs.channel_id, cs.sub_language, COUNT(e.id)
       FROM channel_series cs
       JOIN episodes e ON e.channel_series_id = cs.id AND e.is_members_only = 0 AND ${geoE.sql}
       GROUP BY cs.id
       HAVING COUNT(e.id) > 0`
    ).run(region, ...geoE.params);

    db.prepare(
      `INSERT OR REPLACE INTO region_series_cache (region, series_id, episode_count, sub_languages)
       SELECT ?, e.series_id,
              COUNT(DISTINCT COALESCE(CAST(e.episode_number AS TEXT), e.youtube_video_id)),
              '[]'
       FROM episodes e
       WHERE e.is_members_only = 0 AND ${geoE.sql}
       GROUP BY e.series_id`
    ).run(region, ...geoE.params);

    db.prepare(
      `INSERT OR REPLACE INTO region_channel_cache (region, channel_id, series_count, total_episodes)
       SELECT ?, e.channel_id, COUNT(DISTINCT e.series_id), COUNT(e.id)
       FROM episodes e
       JOIN channels c ON c.id = e.channel_id
       WHERE c.is_verified = 1 AND e.is_members_only = 0 AND ${geoE.sql}
       GROUP BY e.channel_id`
    ).run(region, ...geoE.params);

    db.prepare('INSERT OR REPLACE INTO region_cache_meta (region, built_at) VALUES (?, unixepoch())').run(region);
    const staleRegions = db
      .prepare('SELECT region FROM region_cache_meta ORDER BY built_at DESC LIMIT -1 OFFSET ?')
      .all(MAX_CACHED_REGIONS) as unknown as Array<{ region: string }>;
    for (const stale of staleRegions) {
      db.prepare('DELETE FROM region_cs_cache WHERE region = ?').run(stale.region);
      db.prepare('DELETE FROM region_series_cache WHERE region = ?').run(stale.region);
      db.prepare('DELETE FROM region_channel_cache WHERE region = ?').run(stale.region);
      db.prepare('DELETE FROM region_cache_meta WHERE region = ?').run(stale.region);
    }
    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('regions', 0) ON CONFLICT(key) DO UPDATE SET dirty = 0"
    ).run();
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export function buildEpisodeGeoSql(
  db: DatabaseSync,
  alias: string,
  region: string | null
): { sql: string; params: Array<string | number> } {
  if (!region) return { sql: '1=1', params: [] };
  const pattern = `%"${region}"%`;
  const blockedIds = getBlockedUnsyncedChannelIds(db, region);
  const blockedClause =
    blockedIds.length > 0
      ? `AND (${alias}.details_synced_at IS NOT NULL OR ${alias}.region_allowed IS NOT NULL OR ${alias}.region_blocked IS NOT NULL OR ${alias}.channel_id NOT IN (${blockedIds.map(() => '?').join(',')}))`
      : '';
  return {
    sql: `(
      (${alias}.region_allowed IS NULL OR ${alias}.region_allowed = '[]' OR ${alias}.region_allowed LIKE ?)
      AND (${alias}.region_blocked IS NULL OR ${alias}.region_blocked = '[]' OR ${alias}.region_blocked NOT LIKE ?)
      ${blockedClause}
    )`,
    params: [pattern, pattern, ...blockedIds],
  };
}

export function buildLiveGeoSql(
  db: DatabaseSync,
  alias: string,
  region: string | null
): { sql: string; params: Array<string | number> } {
  if (!region) return { sql: '1=1', params: [] };
  const pattern = `%"${region}"%`;
  const blockedIds = getBlockedUnsyncedChannelIds(db, region);
  const blockedClause =
    blockedIds.length > 0
      ? `AND ((${alias}.region_allowed IS NOT NULL AND ${alias}.region_allowed != '[]') OR (${alias}.region_blocked IS NOT NULL AND ${alias}.region_blocked != '[]') OR ${alias}.channel_id NOT IN (${blockedIds.map(() => '?').join(',')}))`
      : '';
  return {
    sql: `(
      (${alias}.region_allowed IS NULL OR ${alias}.region_allowed = '[]' OR ${alias}.region_allowed LIKE ?)
      AND (${alias}.region_blocked IS NULL OR ${alias}.region_blocked = '[]' OR ${alias}.region_blocked NOT LIKE ?)
      ${blockedClause}
    )`,
    params: [pattern, pattern, ...blockedIds],
  };
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return base || 'series';
}

export function ensureUniqueSlug(db: DatabaseSync, title: string): string {
  const base = slugify(title);
  let candidate = base;
  let counter = 2;
  const check = db.prepare('SELECT 1 FROM series WHERE slug = ? LIMIT 1');
  while (check.get(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  return candidate;
}

const NOISE_TAG_RE = /^(?:muse|ani-?one|youtube|anime\s*full|eng\s*sub|full\s*episode|木棉花|線上看|正版|免費)/i;

function mergeSeriesTags(genresJson: string, episodeTagRows: Array<{ tags: string }>): string[] {
  const counts = new Map<string, number>();
  const addTag = (raw: string, weight: number) => {
    const t = raw.trim();
    if (!t || t.length < 2 || t.length > 32 || NOISE_TAG_RE.test(t)) return;
    counts.set(t, (counts.get(t) || 0) + weight);
  };
  for (const g of parseJsonArray(genresJson)) addTag(g, 10);
  for (const row of episodeTagRows) {
    for (const t of parseJsonArray(row.tags)) addTag(t, 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag);
}

export function refreshSeriesStats(db: DatabaseSync, seriesId: number): void {
  const seriesRow = db
    .prepare('SELECT genres FROM series WHERE id = ?')
    .get(seriesId) as { genres: string } | undefined;
  if (!seriesRow) return;

  const langs = db
    .prepare('SELECT DISTINCT sub_language FROM channel_series WHERE series_id = ?')
    .all(seriesId) as unknown as Array<{ sub_language: string }>;

  const epStats = db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(CAST(episode_number AS TEXT), youtube_video_id)) AS unique_eps,
              MAX(published_at) AS latest_pub,
              COALESCE(SUM(view_count), 0) AS total_views,
              COALESCE(SUM(like_count), 0) AS total_likes,
              COALESCE(SUM(comment_count), 0) AS total_comments,
              MAX(unlocked_at) AS latest_unlock,
              MIN(expires_at) AS soonest_expiry
       FROM episodes
       WHERE series_id = ? AND is_members_only = 0`
    )
    .get(seriesId) as
    | {
        unique_eps: number;
        latest_pub: number | null;
        total_views: number;
        total_likes: number;
        total_comments: number;
        latest_unlock: number | null;
        soonest_expiry: number | null;
      }
    | undefined;

  const fallbackTotal = db
    .prepare('SELECT MAX(episode_count) AS max_eps FROM channel_series WHERE series_id = ?')
    .get(seriesId) as { max_eps: number | null } | undefined;

  const epTagRows = db
    .prepare("SELECT tags FROM episodes WHERE series_id = ? AND is_members_only = 0 AND tags != '[]' LIMIT 15")
    .all(seriesId) as unknown as Array<{ tags: string }>;

  const mergedTags = mergeSeriesTags(seriesRow.genres, epTagRows);
  const episodeCount = epStats?.unique_eps || fallbackTotal?.max_eps || 0;
  const langList = [...new Set(langs.map((l) => l.sub_language).filter(Boolean))];
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `UPDATE series
     SET sub_languages = ?,
         episode_count = ?,
         total_views = ?,
         total_likes = ?,
         total_comments = ?,
         latest_uploaded_at = COALESCE(?, latest_uploaded_at),
         tags = ?,
         unlocked_at = COALESCE(?, unlocked_at),
         expires_at = COALESCE(?, expires_at),
         updated_at = ?
     WHERE id = ?`
  ).run(
    JSON.stringify(langList),
    episodeCount,
    epStats?.total_views || 0,
    epStats?.total_likes || 0,
    epStats?.total_comments || 0,
    epStats?.latest_pub || null,
    JSON.stringify(mergedTags),
    epStats?.latest_unlock || null,
    epStats?.soonest_expiry || null,
    epStats?.latest_pub || now,
    seriesId
  );

  recordViewSnapshot(db, seriesId, epStats?.total_views || 0, now);
  upsertSeriesFts(db, seriesId);
}

const DAY_SECONDS = 86400;

/** Stores at most one view-count snapshot per series per UTC day (latest value wins). */
export function recordViewSnapshot(db: DatabaseSync, seriesId: number, totalViews: number, now = Math.floor(Date.now() / 1000)): void {
  if (totalViews <= 0) return;
  db.prepare(
    `INSERT INTO series_view_snapshots (series_id, captured_at, total_views) VALUES (?, ?, ?)
     ON CONFLICT(series_id, captured_at) DO UPDATE SET total_views = excluded.total_views`
  ).run(seriesId, Math.floor(now / DAY_SECONDS) * DAY_SECONDS, totalViews);
}

export function upsertSeriesFts(db: DatabaseSync, seriesId: number): void {
  const row = db
    .prepare('SELECT id, canonical_title, title_en, title_zh, title_romaji, tags FROM series WHERE id = ?')
    .get(seriesId) as
    | Pick<SeriesRow, 'id' | 'canonical_title' | 'title_en' | 'title_zh' | 'title_romaji' | 'tags'>
    | undefined;
  if (!row) return;

  const channels = db
    .prepare(
      `SELECT DISTINCT c.name
       FROM channel_series cs
       JOIN channels c ON c.id = cs.channel_id
       WHERE cs.series_id = ?`
    )
    .all(seriesId) as unknown as Array<{ name: string }>;

  const channelNames = channels.map((c) => c.name).join(' ');
  const tagsText = parseJsonArray(row.tags).join(' ');
  db.prepare('DELETE FROM series_fts WHERE series_id = ?').run(seriesId);
  db.prepare(
    `INSERT INTO series_fts (series_id, canonical_title, title_en, title_zh, title_romaji, channel_names, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.canonical_title,
    row.title_en || '',
    row.title_zh || '',
    row.title_romaji || '',
    channelNames,
    tagsText
  );
}

export function rebuildAllFts(db: DatabaseSync): void {
  db.exec('DELETE FROM series_fts;');
  const rows = db.prepare('SELECT id FROM series').all() as unknown as Array<{ id: number }>;
  for (const r of rows) {
    upsertSeriesFts(db, r.id);
  }
}

export interface DeleteChannelResult {
  id: number;
  youtubeChannelId: string;
  name: string;
  deletedEpisodes: number;
  removedSeriesCount: number;
  updatedSeriesCount: number;
}

/**
 * Permanently removes a channel and all of its cascaded playlists, videos/episodes,
 * live streams, and locked watch entries. Any series left with no remaining episodes
 * or playlists are also removed; shared series have their stats & FTS refreshed.
 */
export function deleteChannelAndCleanup(db: DatabaseSync, channelId: number): DeleteChannelResult | null {
  const ch = db
    .prepare('SELECT id, youtube_channel_id, name FROM channels WHERE id = ? LIMIT 1')
    .get(channelId) as { id: number; youtube_channel_id: string; name: string } | undefined;
  if (!ch) return null;

  const epCountRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM episodes WHERE channel_id = ?')
    .get(channelId) as { cnt: number };
  const deletedEpisodes = epCountRow?.cnt || 0;

  const affectedSeriesRows = db
    .prepare(
      `SELECT DISTINCT series_id FROM channel_series WHERE channel_id = ?
       UNION
       SELECT DISTINCT series_id FROM episodes WHERE channel_id = ?`
    )
    .all(channelId, channelId) as unknown as Array<{ series_id: number }>;
  const affectedSeriesIds = affectedSeriesRows.map((r) => r.series_id);

  let removedSeriesCount = 0;
  let updatedSeriesCount = 0;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);

    const checkRemaining = db.prepare(
      `SELECT (SELECT COUNT(*) FROM channel_series WHERE series_id = ?) AS cs_cnt,
              (SELECT COUNT(*) FROM episodes WHERE series_id = ?) AS ep_cnt`
    );
    const deleteSeriesFts = db.prepare('DELETE FROM series_fts WHERE series_id = ?');
    const deleteSeries = db.prepare('DELETE FROM series WHERE id = ?');

    for (const sid of affectedSeriesIds) {
      const rem = checkRemaining.get(sid, sid) as { cs_cnt: number; ep_cnt: number };
      if ((rem?.cs_cnt || 0) === 0 && (rem?.ep_cnt || 0) === 0) {
        deleteSeriesFts.run(sid);
        deleteSeries.run(sid);
        removedSeriesCount++;
      } else {
        refreshSeriesStats(db, sid);
        updatedSeriesCount++;
      }
    }

    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('regions', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1"
    ).run();
    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('tags', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1"
    ).run();
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  channelGeoCache.clear();
  return {
    id: ch.id,
    youtubeChannelId: ch.youtube_channel_id,
    name: ch.name,
    deletedEpisodes,
    removedSeriesCount,
    updatedSeriesCount,
  };
}

export interface DeletePlaylistResult {
  id: number;
  channelId: number;
  playlistId: string;
  playlistTitle: string;
  deletedEpisodes: number;
  removedSeries: boolean;
}

/**
 * Permanently removes a specific playlist (`channel_series`) and all of its videos
 * from a channel. Removes the parent `series` if orphaned, otherwise refreshes stats.
 */
export function deletePlaylistAndCleanup(
  db: DatabaseSync,
  channelId: number,
  channelSeriesId: number
): DeletePlaylistResult | null {
  const cs = db
    .prepare(
      'SELECT id, channel_id, series_id, playlist_id, playlist_title FROM channel_series WHERE id = ? AND channel_id = ? LIMIT 1'
    )
    .get(channelSeriesId, channelId) as
    | { id: number; channel_id: number; series_id: number; playlist_id: string; playlist_title: string }
    | undefined;
  if (!cs) return null;

  const epCountRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM episodes WHERE channel_series_id = ?')
    .get(channelSeriesId) as { cnt: number };
  const deletedEpisodes = epCountRow?.cnt || 0;

  let removedSeries = false;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM channel_series WHERE id = ?').run(channelSeriesId);

    const rem = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM channel_series WHERE series_id = ?) AS cs_cnt,
                (SELECT COUNT(*) FROM episodes WHERE series_id = ?) AS ep_cnt`
      )
      .get(cs.series_id, cs.series_id) as { cs_cnt: number; ep_cnt: number };

    if ((rem?.cs_cnt || 0) === 0 && (rem?.ep_cnt || 0) === 0) {
      db.prepare('DELETE FROM series_fts WHERE series_id = ?').run(cs.series_id);
      db.prepare('DELETE FROM series WHERE id = ?').run(cs.series_id);
      removedSeries = true;
    } else {
      refreshSeriesStats(db, cs.series_id);
    }

    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('regions', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1"
    ).run();
    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('tags', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1"
    ).run();
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  channelGeoCache.clear();
  return {
    id: cs.id,
    channelId: cs.channel_id,
    playlistId: cs.playlist_id,
    playlistTitle: cs.playlist_title,
    deletedEpisodes,
    removedSeries,
  };
}

export interface DeleteEpisodeResult {
  id: number;
  channelId: number;
  youtubeVideoId: string;
  title: string;
  removedPlaylist: boolean;
  removedSeries: boolean;
}

/**
 * Permanently removes a specific video (`episodes` row) from a channel.
 * Updates its playlist's episode count (or deletes the playlist if now empty),
 * and refreshes or deletes the parent `series` accordingly.
 */
export function deleteEpisodeAndCleanup(
  db: DatabaseSync,
  channelId: number,
  episodeId: number
): DeleteEpisodeResult | null {
  const ep = db
    .prepare(
      'SELECT id, channel_id, channel_series_id, series_id, youtube_video_id, title FROM episodes WHERE id = ? AND channel_id = ? LIMIT 1'
    )
    .get(episodeId, channelId) as
    | {
        id: number;
        channel_id: number;
        channel_series_id: number;
        series_id: number;
        youtube_video_id: string;
        title: string;
      }
    | undefined;
  if (!ep) return null;

  let removedPlaylist = false;
  let removedSeries = false;

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('DELETE FROM episodes WHERE id = ?').run(episodeId);

    const plCounts = db
      .prepare(
        `SELECT COUNT(*) AS total_cnt,
                SUM(CASE WHEN is_members_only = 0 THEN 1 ELSE 0 END) AS free_cnt
         FROM episodes
         WHERE channel_series_id = ?`
      )
      .get(ep.channel_series_id) as { total_cnt: number; free_cnt: number | null };

    if ((plCounts?.total_cnt || 0) === 0) {
      db.prepare('DELETE FROM channel_series WHERE id = ?').run(ep.channel_series_id);
      removedPlaylist = true;
    } else {
      db.prepare('UPDATE channel_series SET episode_count = ? WHERE id = ?').run(
        plCounts?.free_cnt || 0,
        ep.channel_series_id
      );
    }

    const rem = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM channel_series WHERE series_id = ?) AS cs_cnt,
                (SELECT COUNT(*) FROM episodes WHERE series_id = ?) AS ep_cnt`
      )
      .get(ep.series_id, ep.series_id) as { cs_cnt: number; ep_cnt: number };

    if ((rem?.cs_cnt || 0) === 0 && (rem?.ep_cnt || 0) === 0) {
      db.prepare('DELETE FROM series_fts WHERE series_id = ?').run(ep.series_id);
      db.prepare('DELETE FROM series WHERE id = ?').run(ep.series_id);
      removedSeries = true;
    } else {
      refreshSeriesStats(db, ep.series_id);
    }

    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('regions', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1"
    ).run();
    db.prepare(
      "INSERT INTO cache_flags (key, dirty) VALUES ('tags', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1"
    ).run();
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  channelGeoCache.clear();
  return {
    id: ep.id,
    channelId: ep.channel_id,
    youtubeVideoId: ep.youtube_video_id,
    title: ep.title,
    removedPlaylist,
    removedSeries,
  };
}

export interface SeriesListItem {
  id: number;
  slug: string;
  canonicalTitle: string;
  titleEn: string | null;
  titleZh: string | null;
  titleRomaji: string | null;
  anilistId: number | null;
  posterUrl: string | null;
  episodeCount: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  latestUploadedAt: number | null;
  firstDurationIso: string | null;
  tags: string[];
  subLanguages: string[];
  buzzScore: number;
  buzzTags: string[];
  topCommentQuote: string | null;
  topCommentAuthor: string | null;
  unlockedAt: number | null;
  expiresAt: number | null;
  updatedAt: number;
  channels: Array<{
    channelId: number;
    channelName: string;
    channelAvatar: string | null;
    handle: string | null;
    subLanguage: string;
    playlistId: string;
    playlistTitle: string;
    playlistUrl: string;
    episodeCount: number;
  }>;
}

export function hydrateSeriesListItems(
  db: DatabaseSync,
  seriesRows: Array<SeriesRow & { fallback_thumb: string | null; first_duration: string | null; geo_episode_count?: number }>,
  region: string | null
): SeriesListItem[] {
  if (seriesRows.length === 0) return [];
  const ids = seriesRows.map((s) => s.id);
  const placeholders = ids.map(() => '?').join(',');

  let links: Array<{
    series_id: number;
    channel_id: number;
    playlist_id: string;
    playlist_title: string;
    playlist_url: string;
    sub_language: string;
    episode_count: number;
    channel_name: string;
    handle: string | null;
    channel_avatar: string | null;
  }>;

  if (region) {
    ensureRegionCache(db, region);
    links = db
      .prepare(
        `SELECT cs.series_id, cs.channel_id, cs.playlist_id, cs.playlist_title, cs.playlist_url,
                rcs.sub_language, rcs.episode_count,
                c.name AS channel_name, c.handle, c.avatar_url AS channel_avatar
         FROM region_cs_cache rcs
         JOIN channel_series cs ON cs.id = rcs.channel_series_id
         JOIN channels c ON c.id = cs.channel_id
         WHERE rcs.region = ? AND rcs.series_id IN (${placeholders})
         ORDER BY rcs.episode_count DESC, c.name ASC`
      )
      .all(region, ...ids) as unknown as typeof links;
  } else {
    links = db
      .prepare(
        `SELECT cs.series_id, cs.channel_id, cs.playlist_id, cs.playlist_title, cs.playlist_url,
                cs.sub_language, cs.episode_count, c.name AS channel_name, c.handle, c.avatar_url AS channel_avatar
         FROM channel_series cs
         JOIN channels c ON c.id = cs.channel_id
         WHERE cs.series_id IN (${placeholders})
         ORDER BY cs.episode_count DESC, c.name ASC`
      )
      .all(...ids) as unknown as typeof links;
  }

  const linksBySeries = new Map<number, SeriesListItem['channels']>();
  for (const l of links) {
    const arr = linksBySeries.get(l.series_id) || [];
    arr.push({
      channelId: l.channel_id,
      channelName: l.channel_name,
      channelAvatar: l.channel_avatar,
      handle: l.handle,
      subLanguage: l.sub_language,
      playlistId: l.playlist_id,
      playlistTitle: l.playlist_title,
      playlistUrl: l.playlist_url,
      episodeCount: l.episode_count,
    });
    linksBySeries.set(l.series_id, arr);
  }

  return seriesRows.map((s) => {
    const channels = linksBySeries.get(s.id) || [];
    const subLanguages = region
      ? [...new Set(channels.map((ch) => ch.subLanguage).filter(Boolean))]
      : parseJsonArray(s.sub_languages);
    const episodeCount =
      typeof s.geo_episode_count === 'number' && s.geo_episode_count > 0
        ? s.geo_episode_count
        : s.episode_count;

    return {
      id: s.id,
      slug: s.slug,
      canonicalTitle: s.canonical_title,
      titleEn: s.title_en,
      titleZh: s.title_zh,
      titleRomaji: s.title_romaji,
      anilistId: s.anilist_id,
      posterUrl: s.poster_url || s.fallback_thumb || null,
      episodeCount,
      totalViews: s.total_views || 0,
      totalLikes: s.total_likes || 0,
      totalComments: s.total_comments || 0,
      latestUploadedAt: s.latest_uploaded_at || s.updated_at || null,
      firstDurationIso: s.first_duration || null,
      tags: parseJsonArray(s.tags),
      subLanguages,
      buzzScore: s.buzz_score || 0,
      buzzTags: parseJsonArray(s.buzz_tags),
      topCommentQuote: s.top_comment_quote || null,
      topCommentAuthor: s.top_comment_author || null,
      unlockedAt: s.unlocked_at || null,
      expiresAt: s.expires_at || null,
      updatedAt: s.updated_at,
      channels,
    };
  });
}

export function queryHealth(db: DatabaseSync, rawRegion?: string | null) {
  const region = normalizeRegionCode(rawRegion);
  if (!region) {
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM channels WHERE is_verified = 1) AS channels,
                (SELECT COUNT(*) FROM channels WHERE is_verified = 1) AS totalVerifiedChannels,
                (SELECT COUNT(*) FROM series WHERE episode_count > 0) AS series,
                (SELECT COUNT(*) FROM episodes WHERE is_members_only = 0) AS episodes,
                (SELECT COUNT(*) FROM live_streams WHERE status = 'live') AS liveCount,
                (SELECT MAX(last_synced_at) FROM channels) AS lastSyncedAt`
      )
      .get() as {
      channels: number;
      totalVerifiedChannels: number;
      series: number;
      episodes: number;
      liveCount: number;
      lastSyncedAt: number | null;
    };
    return { ...counts, region: null };
  }

  ensureRegionCache(db, region);
  const geoLs = buildLiveGeoSql(db, 'ls', region);

  const epCounts = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN rcc.total_episodes > 0 THEN rcc.channel_id END) AS channels,
              (SELECT COUNT(*) FROM region_series_cache WHERE region = ? AND episode_count > 0) AS series,
              COALESCE(SUM(rcc.total_episodes), 0) AS episodes
       FROM region_channel_cache rcc
       WHERE rcc.region = ?`
    )
    .get(region, region) as { channels: number; series: number; episodes: number };

  const meta = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM channels WHERE is_verified = 1) AS totalVerifiedChannels,
              (SELECT COUNT(*) FROM live_streams ls WHERE ls.status = 'live' AND ${geoLs.sql}) AS liveCount,
              (SELECT MAX(last_synced_at) FROM channels) AS lastSyncedAt`
    )
    .get(...geoLs.params) as {
    totalVerifiedChannels: number;
    liveCount: number;
    lastSyncedAt: number | null;
  };
  return { ...epCounts, ...meta, region };
}

export function querySeriesList(
  db: DatabaseSync,
  opts: {
    q?: string;
    lang?: string;
    tag?: string;
    channelId?: number;
    region?: string;
    sort?: 'recent' | 'views' | 'episodes' | 'az';
    page?: number;
    limit?: number;
  } = {}
): { items: SeriesListItem[]; total: number; page: number; limit: number } {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 36));
  const offset = (page - 1) * limit;
  const region = normalizeRegionCode(opts.region);

  if (opts.tag && opts.tag.trim()) {
    ensureSeriesTagsIndexed(db);
  }
  if (region) {
    ensureRegionCache(db, region);
  }

  const where: string[] = ['s.episode_count > 0'];
  const params: Array<string | number> = [];

  const regionJoin = region
    ? 'JOIN region_series_cache rsc ON rsc.region = ? AND rsc.series_id = s.id'
    : '';
  const joinParams: Array<string | number> = region ? [region] : [];

  if (opts.q && opts.q.trim()) {
    const q = opts.q.trim();
    const ftsTokens = q
      .replace(/["'*():^]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"*`)
      .join(' ');
    const likePattern = `%${q}%`;
    if (ftsTokens) {
      where.push(
        `(s.id IN (SELECT series_id FROM series_fts WHERE series_fts MATCH ?) OR s.canonical_title LIKE ? OR COALESCE(s.title_en,'') LIKE ? OR COALESCE(s.title_zh,'') LIKE ? OR COALESCE(s.tags,'') LIKE ?)`
      );
      params.push(ftsTokens, likePattern, likePattern, likePattern, likePattern);
    } else {
      where.push(
        `(s.canonical_title LIKE ? OR COALESCE(s.title_en,'') LIKE ? OR COALESCE(s.title_zh,'') LIKE ?)`
      );
      params.push(likePattern, likePattern, likePattern);
    }
  }

  if (opts.tag && opts.tag.trim()) {
    where.push(`s.id IN (SELECT st.series_id FROM series_tags st WHERE st.tag = ?)`);
    params.push(opts.tag.trim().toLowerCase());
  }

  if (opts.lang && opts.lang !== 'all') {
    if (region) {
      if (opts.lang === 'zh') {
        where.push(
          `EXISTS (SELECT 1 FROM region_cs_cache rcs WHERE rcs.region = ? AND rcs.series_id = s.id AND rcs.sub_language LIKE 'zh%')`
        );
        params.push(region);
      } else {
        where.push(
          `EXISTS (SELECT 1 FROM region_cs_cache rcs WHERE rcs.region = ? AND rcs.series_id = s.id AND rcs.sub_language = ?)`
        );
        params.push(region, opts.lang);
      }
    } else {
      if (opts.lang === 'zh') {
        where.push(`EXISTS (SELECT 1 FROM channel_series cs2 WHERE cs2.series_id = s.id AND cs2.sub_language LIKE 'zh%')`);
      } else {
        where.push(`EXISTS (SELECT 1 FROM channel_series cs2 WHERE cs2.series_id = s.id AND cs2.sub_language = ?)`);
        params.push(opts.lang);
      }
    }
  }

  if (opts.channelId) {
    if (region) {
      where.push(
        `EXISTS (SELECT 1 FROM region_cs_cache rcs WHERE rcs.region = ? AND rcs.series_id = s.id AND rcs.channel_id = ?)`
      );
      params.push(region, opts.channelId);
    } else {
      where.push(`EXISTS (SELECT 1 FROM channel_series cs3 WHERE cs3.series_id = s.id AND cs3.channel_id = ?)`);
      params.push(opts.channelId);
    }
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const orderClause =
    opts.sort === 'views'
      ? 'ORDER BY s.total_views DESC, s.episode_count DESC'
      : opts.sort === 'episodes'
        ? region
          ? 'ORDER BY rsc.episode_count DESC, s.total_views DESC'
          : 'ORDER BY s.episode_count DESC, s.total_views DESC'
        : opts.sort === 'az'
          ? 'ORDER BY s.canonical_title COLLATE NOCASE ASC'
          : 'ORDER BY COALESCE(s.latest_uploaded_at, s.updated_at) DESC, s.total_views DESC';

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM series s ${regionJoin} ${whereClause}`)
    .get(...joinParams, ...params) as { cnt: number };

  const geoCountSelect = region
    ? ',rsc.episode_count AS geo_episode_count'
    : ',NULL AS geo_episode_count';

  const seriesRows = db
    .prepare(
      `SELECT s.*,
              (SELECT cs.thumbnail_url FROM channel_series cs WHERE cs.series_id = s.id AND cs.thumbnail_url IS NOT NULL LIMIT 1) AS fallback_thumb,
              (SELECT e.duration_iso FROM episodes e WHERE e.series_id = s.id AND e.is_members_only = 0 AND e.duration_iso IS NOT NULL ORDER BY e.episode_number ASC LIMIT 1) AS first_duration
              ${geoCountSelect}
       FROM series s
       ${regionJoin}
       ${whereClause}
       ${orderClause}
       LIMIT ? OFFSET ?`
    )
    .all(...joinParams, ...params, limit, offset) as unknown as Array<
    SeriesRow & { fallback_thumb: string | null; first_duration: string | null; geo_episode_count: number | null }
  >;

  const normalizedRows = seriesRows.map((r) => ({
    ...r,
    geo_episode_count: typeof r.geo_episode_count === 'number' ? r.geo_episode_count : undefined,
  }));

  const items = hydrateSeriesListItems(db, normalizedRows, region);
  return { items, total: countRow.cnt, page, limit };
}

export function querySeriesDetail(db: DatabaseSync, slug: string, rawRegion?: string | null) {
  const s = db.prepare('SELECT * FROM series WHERE slug = ? LIMIT 1').get(slug) as unknown as SeriesRow | undefined;
  if (!s) return null;

  const region = normalizeRegionCode(rawRegion);
  const sources = db
    .prepare(
      `SELECT cs.*, c.name AS channel_name, c.handle, c.url AS channel_url, c.avatar_url AS channel_avatar,
              c.youtube_channel_id, c.region_focus
       FROM channel_series cs
       JOIN channels c ON c.id = cs.channel_id
       WHERE cs.series_id = ?
       ORDER BY cs.episode_count DESC, c.name ASC`
    )
    .all(s.id) as unknown as Array<
    ChannelSeriesRow & {
      channel_name: string;
      handle: string | null;
      channel_url: string;
      channel_avatar: string | null;
      youtube_channel_id: string;
      region_focus: string | null;
    }
  >;

  const geoE = buildEpisodeGeoSql(db, 'e', region);
  const episodes = db
    .prepare(
      `SELECT e.*
       FROM episodes e
       WHERE e.series_id = ? AND e.is_members_only = 0 AND ${geoE.sql}
       ORDER BY e.channel_series_id ASC,
                CASE WHEN e.episode_number IS NULL THEN 1 ELSE 0 END ASC,
                e.episode_number ASC,
                e.playlist_position ASC`
    )
    .all(s.id, ...geoE.params) as unknown as EpisodeRow[];

  const totalFree = (
    db.prepare('SELECT COUNT(*) AS cnt FROM episodes WHERE series_id = ? AND is_members_only = 0').get(s.id) as {
      cnt: number;
    }
  ).cnt;

  const epCountsByCs = new Map<number, number>();
  for (const ep of episodes) {
    epCountsByCs.set(ep.channel_series_id, (epCountsByCs.get(ep.channel_series_id) || 0) + 1);
  }
  const filteredSources = region ? sources.filter((src) => (epCountsByCs.get(src.id) || 0) > 0) : sources;
  const regionBlocked = Boolean(region && totalFree > 0 && episodes.length === 0);

  return {
    region,
    regionBlocked,
    // Official channel/playlist links for the region-locked card; never includes video ids.
    lockedSources: regionBlocked
      ? sources.map((src) => ({
          channelName: src.channel_name,
          channelUrl: src.channel_url,
          channelAvatar: src.channel_avatar,
          playlistUrl: src.playlist_url,
          regionFocus: src.region_focus,
          subLanguage: src.sub_language,
        }))
      : [],
    series: {
      id: s.id,
      slug: s.slug,
      canonicalTitle: s.canonical_title,
      titleEn: s.title_en,
      titleZh: s.title_zh,
      titleRomaji: s.title_romaji,
      anilistId: s.anilist_id,
      posterUrl: s.poster_url || filteredSources[0]?.thumbnail_url || sources[0]?.thumbnail_url || null,
      bannerUrl: s.banner_url,
      synopsis: s.synopsis,
      genres: parseJsonArray(s.genres),
      tags: parseJsonArray(s.tags),
      seasonYear: s.season_year,
      subLanguages: parseJsonArray(s.sub_languages),
      episodeCount: region ? episodes.length : s.episode_count,
      totalViews: s.total_views || 0,
      totalLikes: s.total_likes || 0,
      totalComments: s.total_comments || 0,
      latestUploadedAt: s.latest_uploaded_at || s.updated_at || null,
      buzzScore: s.buzz_score || 0,
      buzzTags: parseJsonArray(s.buzz_tags),
      topCommentQuote: s.top_comment_quote || null,
      topCommentAuthor: s.top_comment_author || null,
      topCommentLikes: s.top_comment_likes || 0,
    },
    sources: filteredSources.map((src) => ({
      id: src.id,
      channelId: src.channel_id,
      channelName: src.channel_name,
      channelHandle: src.handle,
      channelUrl: src.channel_url,
      channelAvatar: src.channel_avatar,
      youtubeChannelId: src.youtube_channel_id,
      regionFocus: src.region_focus,
      playlistId: src.playlist_id,
      playlistTitle: src.playlist_title,
      playlistUrl: src.playlist_url,
      subLanguage: src.sub_language,
      episodeCount: region ? epCountsByCs.get(src.id) || 0 : src.episode_count,
      accessNote: src.access_note,
    })),
    episodes: episodes.map((ep) => ({
      id: ep.id,
      channelSeriesId: ep.channel_series_id,
      channelId: ep.channel_id,
      youtubeVideoId: ep.youtube_video_id,
      title: ep.title,
      description: ep.description || null,
      episodeNumber: ep.episode_number,
      playlistPosition: ep.playlist_position,
      subLanguage: ep.sub_language,
      durationIso: ep.duration_iso,
      thumbnailUrl: ep.thumbnail_url || `https://i.ytimg.com/vi/${ep.youtube_video_id}/hqdefault.jpg`,
      publishedAt: ep.published_at,
      viewCount: ep.view_count ?? null,
      likeCount: ep.like_count ?? null,
      commentCount: ep.comment_count ?? null,
      tags: parseJsonArray(ep.tags),
      unlockedAt: ep.unlocked_at ?? null,
      expiresAt: ep.expires_at ?? null,
      regionAllowed: parseJsonArray(ep.region_allowed),
      regionBlocked: parseJsonArray(ep.region_blocked),
    })),
  };
}

export function queryChannelsList(db: DatabaseSync, rawRegion?: string | null) {
  const region = normalizeRegionCode(rawRegion);
  let rows: Array<ChannelRow & { series_count: number; total_episodes: number }>;

  if (region) {
    ensureRegionCache(db, region);
    rows = db
      .prepare(
        `SELECT c.*,
                COALESCE(rcc.series_count, 0) AS series_count,
                COALESCE(rcc.total_episodes, 0) AS total_episodes
         FROM channels c
         LEFT JOIN region_channel_cache rcc
           ON rcc.channel_id = c.id
          AND rcc.region = ?
         WHERE c.is_verified = 1
         ORDER BY series_count DESC, total_episodes DESC, c.name COLLATE NOCASE ASC`
      )
      .all(region) as unknown as typeof rows;
  } else {
    rows = db
      .prepare(
        `SELECT c.*,
                COUNT(DISTINCT cs.series_id) AS series_count,
                COALESCE(SUM(cs.episode_count), 0) AS total_episodes
         FROM channels c
         LEFT JOIN channel_series cs ON cs.channel_id = c.id
         WHERE c.is_verified = 1
         GROUP BY c.id
         ORDER BY series_count DESC, c.name COLLATE NOCASE ASC`
      )
      .all() as unknown as typeof rows;
  }

  return rows.map((c) => ({
    id: c.id,
    youtubeChannelId: c.youtube_channel_id,
    handle: c.handle,
    name: c.name,
    url: c.url,
    avatarUrl: c.avatar_url,
    description: c.description,
    regionFocus: c.region_focus,
    subLanguages: parseJsonArray(c.sub_languages),
    category: c.category,
    playlistCount: c.playlist_count,
    seriesCount: c.series_count,
    totalEpisodes: c.total_episodes,
    lastSyncedAt: c.last_synced_at,
  }));
}

export function queryTopTags(db: DatabaseSync, limit = 20, rawRegion?: string | null): Array<{ tag: string; count: number }> {
  const region = normalizeRegionCode(rawRegion);
  if (region) ensureRegionCache(db, region);

  const rows = region
    ? (db
        .prepare(
          `SELECT s.tags FROM series s
           JOIN region_series_cache rsc ON rsc.region = ? AND rsc.series_id = s.id
           WHERE s.episode_count > 0 AND s.tags != '[]'
           ORDER BY s.total_views DESC LIMIT 500`
        )
        .all(region) as unknown as Array<{ tags: string }>)
    : (db
        .prepare(
          `SELECT s.tags FROM series s
           WHERE s.episode_count > 0 AND s.tags != '[]'
           ORDER BY s.total_views DESC LIMIT 500`
        )
        .all() as unknown as Array<{ tags: string }>);

  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const tag of parseJsonArray(r.tags)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

export function queryLiveStreams(db: DatabaseSync, rawRegion?: string | null) {
  const region = normalizeRegionCode(rawRegion);
  const geoLs = buildLiveGeoSql(db, 'ls', region);

  return db
    .prepare(
      `SELECT ls.*, c.name AS channel_name, c.handle, c.avatar_url AS channel_avatar, c.url AS channel_url,
              c.region_focus
       FROM live_streams ls
       JOIN channels c ON c.id = ls.channel_id
       WHERE ls.status IN ('live', 'upcoming') AND ${geoLs.sql}
       ORDER BY CASE ls.status WHEN 'live' THEN 0 ELSE 1 END ASC, ls.concurrent_viewers DESC`
    )
    .all(...geoLs.params) as unknown as Array<
    LiveStreamRow & {
      channel_name: string;
      handle: string | null;
      channel_avatar: string | null;
      channel_url: string;
      region_focus: string | null;
    }
  >;
}

export interface SongListItem {
  id: number;
  channelId: number;
  channelName: string;
  channelAvatar: string | null;
  channelUrl: string;
  regionFocus: string | null;
  seriesId: number | null;
  seriesSlug: string | null;
  seriesTitle: string | null;
  youtubeVideoId: string;
  playlistId: string | null;
  playlistTitle: string | null;
  title: string;
  songType: 'op' | 'ed' | 'ost';
  animeTitle: string | null;
  durationIso: string | null;
  thumbnailUrl: string | null;
  publishedAt: number | null;
  viewCount: number;
  likeCount: number;
  regionAllowed: string[];
  regionBlocked: string[];
}

export function querySongsList(
  db: DatabaseSync,
  opts: {
    type?: 'all' | 'op' | 'ed' | 'ost';
    q?: string;
    channelId?: number;
    region?: string | null;
    sort?: 'views' | 'recent' | 'az';
    page?: number;
    limit?: number;
  } = {}
): {
  items: SongListItem[];
  total: number;
  page: number;
  limit: number;
  counts: { all: number; op: number; ed: number; ost: number };
} {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 36));
  const offset = (page - 1) * limit;
  const region = normalizeRegionCode(opts.region);
  const geoSg = buildLiveGeoSql(db, 'sg', region);

  const baseWhere: string[] = ['c.is_verified = 1', geoSg.sql];
  const baseParams: Array<string | number> = [...geoSg.params];

  if (opts.channelId) {
    baseWhere.push('sg.channel_id = ?');
    baseParams.push(opts.channelId);
  }
  if (opts.q && opts.q.trim()) {
    const like = `%${opts.q.trim()}%`;
    baseWhere.push(
      "(sg.title LIKE ? OR COALESCE(sg.anime_title, '') LIKE ? OR COALESCE(sg.playlist_title, '') LIKE ? OR c.name LIKE ?)"
    );
    baseParams.push(like, like, like, like);
  }

  const baseWhereSql = baseWhere.join(' AND ');
  const countRows = db
    .prepare(
      `SELECT sg.song_type, COUNT(*) AS cnt
       FROM songs sg
       JOIN channels c ON c.id = sg.channel_id
       WHERE ${baseWhereSql}
       GROUP BY sg.song_type`
    )
    .all(...baseParams) as unknown as Array<{ song_type: string; cnt: number }>;

  const counts = { all: 0, op: 0, ed: 0, ost: 0 };
  for (const r of countRows) {
    if (r.song_type === 'op') counts.op = r.cnt;
    else if (r.song_type === 'ed') counts.ed = r.cnt;
    else counts.ost += r.cnt;
    counts.all += r.cnt;
  }

  const where = [...baseWhere];
  const params = [...baseParams];
  if (opts.type && opts.type !== 'all') {
    where.push('sg.song_type = ?');
    params.push(opts.type);
  }

  const whereSql = where.join(' AND ');
  const total =
    opts.type && opts.type !== 'all'
      ? opts.type === 'op'
        ? counts.op
        : opts.type === 'ed'
          ? counts.ed
          : counts.ost
      : counts.all;

  const orderClause =
    opts.sort === 'recent'
      ? 'ORDER BY COALESCE(sg.published_at, sg.created_at) DESC, COALESCE(sg.view_count, 0) DESC'
      : opts.sort === 'az'
        ? 'ORDER BY sg.title COLLATE NOCASE ASC'
        : 'ORDER BY COALESCE(sg.view_count, 0) DESC, COALESCE(sg.published_at, sg.created_at) DESC';

  const rows = db
    .prepare(
      `SELECT sg.*, c.name AS channel_name, c.avatar_url AS channel_avatar, c.url AS channel_url,
              c.region_focus, s.slug AS series_slug, s.canonical_title AS series_title
       FROM songs sg
       JOIN channels c ON c.id = sg.channel_id
       LEFT JOIN series s ON s.id = sg.series_id
       WHERE ${whereSql}
       ${orderClause}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as unknown as Array<
    SongRow & {
      channel_name: string;
      channel_avatar: string | null;
      channel_url: string;
      region_focus: string | null;
      series_slug: string | null;
      series_title: string | null;
    }
  >;

  const items: SongListItem[] = rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    channelAvatar: r.channel_avatar,
    channelUrl: r.channel_url,
    regionFocus: r.region_focus,
    seriesId: r.series_id,
    seriesSlug: r.series_slug,
    seriesTitle: r.series_title,
    youtubeVideoId: r.youtube_video_id,
    playlistId: r.playlist_id,
    playlistTitle: r.playlist_title,
    title: r.title,
    songType: r.song_type === 'op' || r.song_type === 'ed' ? r.song_type : 'ost',
    animeTitle: r.anime_title,
    durationIso: r.duration_iso,
    thumbnailUrl: r.thumbnail_url,
    publishedAt: r.published_at,
    viewCount: r.view_count || 0,
    likeCount: r.like_count || 0,
    regionAllowed: parseJsonArray(r.region_allowed),
    regionBlocked: parseJsonArray(r.region_blocked),
  }));

  return { items, total, page, limit, counts };
}

export interface SongGroupItem {
  groupKey: string;
  title: string;
  seriesSlug: string | null;
  thumbnailUrl: string | null;
  channelName: string;
  channelAvatar: string | null;
  trackCount: number;
  opCount: number;
  edCount: number;
  ostCount: number;
  totalViews: number;
  latestPublishedAt: number | null;
  tracks: SongListItem[];
}

export function querySongGroups(
  db: DatabaseSync,
  opts: {
    type?: 'all' | 'op' | 'ed' | 'ost';
    q?: string;
    channelId?: number;
    region?: string | null;
    sort?: 'views' | 'recent' | 'az';
    page?: number;
    limit?: number;
  } = {}
): {
  groups: SongGroupItem[];
  total: number;
  page: number;
  limit: number;
  counts: { all: number; op: number; ed: number; ost: number };
} {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 24));
  const region = normalizeRegionCode(opts.region);
  const geoSg = buildLiveGeoSql(db, 'sg', region);

  const baseWhere: string[] = ['c.is_verified = 1', geoSg.sql];
  const baseParams: Array<string | number> = [...geoSg.params];

  if (opts.channelId) {
    baseWhere.push('sg.channel_id = ?');
    baseParams.push(opts.channelId);
  }
  if (opts.q && opts.q.trim()) {
    const like = `%${opts.q.trim()}%`;
    baseWhere.push(
      "(sg.title LIKE ? OR COALESCE(sg.anime_title, '') LIKE ? OR COALESCE(sg.playlist_title, '') LIKE ? OR c.name LIKE ?)"
    );
    baseParams.push(like, like, like, like);
  }

  const baseWhereSql = baseWhere.join(' AND ');
  const countRows = db
    .prepare(
      `SELECT sg.song_type, COUNT(*) AS cnt
       FROM songs sg
       JOIN channels c ON c.id = sg.channel_id
       WHERE ${baseWhereSql}
       GROUP BY sg.song_type`
    )
    .all(...baseParams) as unknown as Array<{ song_type: string; cnt: number }>;

  const counts = { all: 0, op: 0, ed: 0, ost: 0 };
  for (const r of countRows) {
    if (r.song_type === 'op') counts.op = r.cnt;
    else if (r.song_type === 'ed') counts.ed = r.cnt;
    else counts.ost += r.cnt;
    counts.all += r.cnt;
  }

  const where = [...baseWhere];
  const params = [...baseParams];
  if (opts.type && opts.type !== 'all') {
    where.push('sg.song_type = ?');
    params.push(opts.type);
  }

  const rows = db
    .prepare(
      `SELECT sg.*, c.name AS channel_name, c.avatar_url AS channel_avatar, c.url AS channel_url,
              c.region_focus, s.slug AS series_slug, s.canonical_title AS series_title, s.poster_url AS series_poster
       FROM songs sg
       JOIN channels c ON c.id = sg.channel_id
       LEFT JOIN series s ON s.id = sg.series_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(sg.view_count, 0) DESC, COALESCE(sg.published_at, sg.created_at) DESC
       LIMIT 1500`
    )
    .all(...params) as unknown as Array<
    SongRow & {
      channel_name: string;
      channel_avatar: string | null;
      channel_url: string;
      region_focus: string | null;
      series_slug: string | null;
      series_title: string | null;
      series_poster: string | null;
    }
  >;

  const groupMap = new Map<string, SongGroupItem>();
  for (const r of rows) {
    const songType: 'op' | 'ed' | 'ost' = r.song_type === 'op' || r.song_type === 'ed' ? r.song_type : 'ost';
    const item: SongListItem = {
      id: r.id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      channelAvatar: r.channel_avatar,
      channelUrl: r.channel_url,
      regionFocus: r.region_focus,
      seriesId: r.series_id,
      seriesSlug: r.series_slug,
      seriesTitle: r.series_title,
      youtubeVideoId: r.youtube_video_id,
      playlistId: r.playlist_id,
      playlistTitle: r.playlist_title,
      title: r.title,
      songType,
      animeTitle: r.anime_title,
      durationIso: r.duration_iso,
      thumbnailUrl: r.thumbnail_url,
      publishedAt: r.published_at,
      viewCount: r.view_count || 0,
      likeCount: r.like_count || 0,
      regionAllowed: parseJsonArray(r.region_allowed),
      regionBlocked: parseJsonArray(r.region_blocked),
    };

    const rawGroupTitle = (r.series_title || r.anime_title || r.playlist_title || r.title).trim();
    const normTitleKey = rawGroupTitle.toLowerCase().replace(/\s+/g, ' ');
    const groupKey = r.series_id
      ? `series:${r.series_id}`
      : r.playlist_id
        ? `playlist:${r.channel_id}:${r.playlist_id}`
        : `anime:${normTitleKey}`;

    let grp = groupMap.get(groupKey);
    if (!grp) {
      grp = {
        groupKey,
        title: rawGroupTitle,
        seriesSlug: r.series_slug,
        thumbnailUrl: r.thumbnail_url || r.series_poster || null,
        channelName: r.channel_name,
        channelAvatar: r.channel_avatar,
        trackCount: 0,
        opCount: 0,
        edCount: 0,
        ostCount: 0,
        totalViews: 0,
        latestPublishedAt: null,
        tracks: [],
      };
      groupMap.set(groupKey, grp);
    }

    grp.tracks.push(item);
    grp.trackCount++;
    if (songType === 'op') grp.opCount++;
    else if (songType === 'ed') grp.edCount++;
    else grp.ostCount++;
    grp.totalViews += item.viewCount;
    if (item.publishedAt && (!grp.latestPublishedAt || item.publishedAt > grp.latestPublishedAt)) {
      grp.latestPublishedAt = item.publishedAt;
    }
    if (!grp.thumbnailUrl && item.thumbnailUrl) {
      grp.thumbnailUrl = item.thumbnailUrl;
    }
  }

  const typeOrder = { op: 0, ed: 1, ost: 2 };
  const allGroups = [...groupMap.values()];
  for (const grp of allGroups) {
    grp.tracks.sort((a, b) => typeOrder[a.songType] - typeOrder[b.songType] || b.viewCount - a.viewCount);
  }

  if (opts.sort === 'recent') {
    allGroups.sort((a, b) => (b.latestPublishedAt || 0) - (a.latestPublishedAt || 0) || b.totalViews - a.totalViews);
  } else if (opts.sort === 'az') {
    allGroups.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  } else {
    allGroups.sort((a, b) => b.totalViews - a.totalViews || b.trackCount - a.trackCount);
  }

  const total = allGroups.length;
  const offset = (page - 1) * limit;
  const groups = allGroups.slice(offset, offset + limit);

  return { groups, total, page, limit, counts };
}

export interface VideoSearchItem {
  kind: 'episode' | 'song';
  id: number;
  youtubeVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  durationIso: string | null;
  viewCount: number;
  likeCount: number;
  publishedAt: number | null;
  channelId: number;
  channelName: string;
  channelAvatar: string | null;
  channelUrl: string;
  regionFocus: string | null;
  seriesSlug: string | null;
  seriesTitle: string | null;
  episodeNumber: number | null;
  songType: 'op' | 'ed' | 'ost' | null;
  playlistId: string | null;
  playlistTitle: string | null;
  regionAllowed: string[];
  regionBlocked: string[];
}

export function queryVideosSearch(
  db: DatabaseSync,
  opts: {
    q: string;
    region?: string | null;
    channelId?: number;
    limit?: number;
  }
): { items: VideoSearchItem[]; total: number } {
  const q = opts.q.trim();
  if (!q) return { items: [], total: 0 };

  const limit = Math.min(48, Math.max(1, opts.limit || 16));
  const region = normalizeRegionCode(opts.region);
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);

  // Match episodes where every search token appears across video title, series title, channel name, or exact video ID
  const epGeo = buildEpisodeGeoSql(db, 'e', region);
  const epWhere: string[] = ['c.is_verified = 1', 'e.is_members_only = 0', epGeo.sql];
  const epParams: Array<string | number> = [...epGeo.params];
  if (opts.channelId) {
    epWhere.push('e.channel_id = ?');
    epParams.push(opts.channelId);
  }
  for (const tok of tokens) {
    const like = `%${tok}%`;
    epWhere.push(
      "(e.title LIKE ? OR e.youtube_video_id = ? OR COALESCE(s.canonical_title, '') LIKE ? OR COALESCE(s.title_en, '') LIKE ? OR COALESCE(s.title_zh, '') LIKE ? OR c.name LIKE ?)"
    );
    epParams.push(like, tok, like, like, like, like);
  }

  const epRows = db
    .prepare(
      `SELECT e.id, e.youtube_video_id, e.title, e.thumbnail_url, e.duration_iso,
              e.view_count, e.like_count, e.published_at, e.episode_number,
              e.region_allowed, e.region_blocked,
              c.id AS channel_id, c.name AS channel_name, c.avatar_url AS channel_avatar, c.url AS channel_url, c.region_focus,
              s.slug AS series_slug, s.canonical_title AS series_title,
              cs.playlist_id, cs.playlist_title
       FROM episodes e
       JOIN channels c ON c.id = e.channel_id
       JOIN series s ON s.id = e.series_id
       LEFT JOIN channel_series cs ON cs.id = e.channel_series_id
       WHERE ${epWhere.join(' AND ')}
       ORDER BY COALESCE(e.view_count, 0) DESC, COALESCE(e.published_at, 0) DESC
       LIMIT ?`
    )
    .all(...epParams, limit) as unknown as Array<Record<string, unknown>>;

  // Match songs where every search token appears across song title, anime title, channel name, or exact video ID
  const sgGeo = buildLiveGeoSql(db, 'sg', region);
  const sgWhere: string[] = ['c.is_verified = 1', sgGeo.sql];
  const sgParams: Array<string | number> = [...sgGeo.params];
  if (opts.channelId) {
    sgWhere.push('sg.channel_id = ?');
    sgParams.push(opts.channelId);
  }
  for (const tok of tokens) {
    const like = `%${tok}%`;
    sgWhere.push(
      "(sg.title LIKE ? OR sg.youtube_video_id = ? OR COALESCE(sg.anime_title, '') LIKE ? OR COALESCE(sg.playlist_title, '') LIKE ? OR c.name LIKE ?)"
    );
    sgParams.push(like, tok, like, like, like);
  }

  const sgRows = db
    .prepare(
      `SELECT sg.id, sg.youtube_video_id, sg.title, sg.thumbnail_url, sg.duration_iso,
              sg.view_count, sg.like_count, sg.published_at, sg.song_type,
              sg.region_allowed, sg.region_blocked, sg.playlist_id, sg.playlist_title,
              c.id AS channel_id, c.name AS channel_name, c.avatar_url AS channel_avatar, c.url AS channel_url, c.region_focus,
              s.slug AS series_slug, s.canonical_title AS series_title
       FROM songs sg
       JOIN channels c ON c.id = sg.channel_id
       LEFT JOIN series s ON s.id = sg.series_id
       WHERE ${sgWhere.join(' AND ')}
       ORDER BY COALESCE(sg.view_count, 0) DESC, COALESCE(sg.published_at, 0) DESC
       LIMIT ?`
    )
    .all(...sgParams, Math.min(8, limit)) as unknown as Array<Record<string, unknown>>;

  const seenVidIds = new Set<string>();
  const merged: VideoSearchItem[] = [];

  for (const r of epRows) {
    const vid = String(r.youtube_video_id);
    if (seenVidIds.has(vid)) continue;
    seenVidIds.add(vid);
    merged.push({
      kind: 'episode',
      id: Number(r.id),
      youtubeVideoId: vid,
      title: String(r.title || ''),
      thumbnailUrl: (r.thumbnail_url as string | null) ?? null,
      durationIso: (r.duration_iso as string | null) ?? null,
      viewCount: Number(r.view_count) || 0,
      likeCount: Number(r.like_count) || 0,
      publishedAt: (r.published_at as number | null) ?? null,
      channelId: Number(r.channel_id),
      channelName: String(r.channel_name || ''),
      channelAvatar: (r.channel_avatar as string | null) ?? null,
      channelUrl: String(r.channel_url || ''),
      regionFocus: (r.region_focus as string | null) ?? null,
      seriesSlug: (r.series_slug as string | null) ?? null,
      seriesTitle: (r.series_title as string | null) ?? null,
      episodeNumber: r.episode_number !== null && r.episode_number !== undefined ? Number(r.episode_number) : null,
      songType: null,
      playlistId: (r.playlist_id as string | null) ?? null,
      playlistTitle: (r.playlist_title as string | null) ?? null,
      regionAllowed: parseJsonArray(r.region_allowed as string | null),
      regionBlocked: parseJsonArray(r.region_blocked as string | null),
    });
  }

  for (const r of sgRows) {
    const vid = String(r.youtube_video_id);
    if (seenVidIds.has(vid)) continue;
    seenVidIds.add(vid);
    const st = r.song_type === 'op' || r.song_type === 'ed' ? r.song_type : 'ost';
    merged.push({
      kind: 'song',
      id: Number(r.id),
      youtubeVideoId: vid,
      title: String(r.title || ''),
      thumbnailUrl: (r.thumbnail_url as string | null) ?? null,
      durationIso: (r.duration_iso as string | null) ?? null,
      viewCount: Number(r.view_count) || 0,
      likeCount: Number(r.like_count) || 0,
      publishedAt: (r.published_at as number | null) ?? null,
      channelId: Number(r.channel_id),
      channelName: String(r.channel_name || ''),
      channelAvatar: (r.channel_avatar as string | null) ?? null,
      channelUrl: String(r.channel_url || ''),
      regionFocus: (r.region_focus as string | null) ?? null,
      seriesSlug: (r.series_slug as string | null) ?? null,
      seriesTitle: (r.series_title as string | null) ?? null,
      episodeNumber: null,
      songType: st,
      playlistId: (r.playlist_id as string | null) ?? null,
      playlistTitle: (r.playlist_title as string | null) ?? null,
      regionAllowed: parseJsonArray(r.region_allowed as string | null),
      regionBlocked: parseJsonArray(r.region_blocked as string | null),
    });
  }

  merged.sort((a, b) => b.viewCount - a.viewCount || (b.publishedAt || 0) - (a.publishedAt || 0));
  const items = merged.slice(0, limit);
  return { items, total: items.length };
}
