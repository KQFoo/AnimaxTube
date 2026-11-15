import type { DatabaseSync } from 'node:sqlite';
import {
  ensureRegionCache,
  hydrateSeriesListItems,
  normalizeRegionCode,
  parseJsonArray,
  type SeriesListItem,
} from './index.ts';
import type { SeriesRow } from './schema.ts';

export const MIN_SHELF_EPISODES = 3;
const HIDDEN_GEM_MAX_VIEWS = 500_000;
const SHELF_SIZE = 16;

/** Shelf eligibility: enough episodes and at least one free episode playable in `region`. */
function shelfEligibility(db: DatabaseSync, region: string | null) {
  if (!region) {
    return {
      clause: `s.episode_count >= ${MIN_SHELF_EPISODES}`,
      params: [] as Array<string | number>,
    };
  }
  ensureRegionCache(db, region);
  return {
    clause: `s.episode_count >= ${MIN_SHELF_EPISODES}
      AND EXISTS (SELECT 1 FROM region_series_cache rsc WHERE rsc.region = ? AND rsc.series_id = s.id)`,
    params: [region] as Array<string | number>,
  };
}

/** Hydrates series ids into list items, preserving the given order. */
function hydrateIds(db: DatabaseSync, ids: number[], region: string | null): SeriesListItem[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT s.*,
              (SELECT cs.thumbnail_url FROM channel_series cs WHERE cs.series_id = s.id AND cs.thumbnail_url IS NOT NULL LIMIT 1) AS fallback_thumb,
              (SELECT e.duration_iso FROM episodes e WHERE e.series_id = s.id AND e.is_members_only = 0 AND e.duration_iso IS NOT NULL ORDER BY e.episode_number ASC LIMIT 1) AS first_duration
       FROM series s
       WHERE s.id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as unknown as Array<SeriesRow & { fallback_thumb: string | null; first_duration: string | null }>;
  const byId = new Map(hydrateSeriesListItems(db, rows, region).map((it) => [it.id, it]));
  return ids.map((id) => byId.get(id)).filter((x): x is SeriesListItem => Boolean(x));
}

function topTags(item: SeriesListItem): Set<string> {
  return new Set(item.tags.slice(0, 5).map((t) => t.toLowerCase()));
}

/**
 * Greedy MMR-style re-rank of an already-ranked list: at most `maxPerChannel` items per
 * primary channel, and a penalty for items sharing more than `maxSharedTags` top tags with
 * something already picked. Leftovers backfill only if the shelf would otherwise be short.
 */
export function diversifyShelf(
  ranked: SeriesListItem[],
  { limit = SHELF_SIZE, maxPerChannel = 2, maxSharedTags = 2, tagPenalty = 0.35 } = {}
): SeriesListItem[] {
  const n = ranked.length;
  const pool = ranked.map((item, i) => ({ item, base: 1 - i / Math.max(1, n), tags: topTags(item) }));
  const picked: typeof pool = [];
  const perChannel = new Map<number, number>();
  const channelOf = (it: SeriesListItem) => it.channels[0]?.channelId ?? -1;

  while (picked.length < limit) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      if ((perChannel.get(channelOf(cand.item)) || 0) >= maxPerChannel) continue;
      const overlaps = picked.some((p) => {
        let shared = 0;
        for (const t of cand.tags) if (p.tags.has(t)) shared++;
        return shared > maxSharedTags;
      });
      const score = cand.base - (overlaps ? tagPenalty : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const [chosen] = pool.splice(bestIdx, 1);
    picked.push(chosen);
    const ch = channelOf(chosen.item);
    perChannel.set(ch, (perChannel.get(ch) || 0) + 1);
  }

  for (const rest of pool) {
    if (picked.length >= limit) break;
    picked.push(rest);
  }
  return picked.map((p) => p.item);
}

interface SimilarityProfile {
  id: number;
  slug: string;
  canonicalTitle: string;
  genres: Set<string>;
  tags: Set<string>;
  buzzTags: Set<string>;
  channels: Set<number>;
  langs: Set<string>;
  buzzScore: number;
  totalViews: number;
}

interface ProfileRow {
  id: number;
  slug: string;
  canonical_title: string;
  genres: string;
  tags: string;
  buzz_tags: string;
  sub_languages: string;
  buzz_score: number;
  total_views: number;
  channel_ids: string | null;
}

const PROFILE_SELECT = `SELECT s.id, s.slug, s.canonical_title, s.genres, s.tags, s.buzz_tags, s.sub_languages,
       s.buzz_score, s.total_views,
       (SELECT GROUP_CONCAT(DISTINCT cs.channel_id) FROM channel_series cs WHERE cs.series_id = s.id) AS channel_ids
  FROM series s`;

const lowerSet = (json: string) => new Set(parseJsonArray(json).map((t) => t.toLowerCase()));

function toProfile(r: ProfileRow): SimilarityProfile {
  return {
    id: r.id,
    slug: r.slug,
    canonicalTitle: r.canonical_title,
    genres: lowerSet(r.genres),
    tags: lowerSet(r.tags),
    buzzTags: lowerSet(r.buzz_tags),
    channels: new Set((r.channel_ids || '').split(',').filter(Boolean).map(Number)),
    langs: new Set(parseJsonArray(r.sub_languages)),
    buzzScore: r.buzz_score || 0,
    totalViews: r.total_views || 0,
  };
}

/** Inverse document frequency per term; terms missing from the map count as rare. */
export type IdfMap = Map<string, number>;

export function buildIdf(profiles: SimilarityProfile[]): { idf: IdfMap; common: Set<string>; maxIdf: number } {
  const df = new Map<string, number>();
  for (const p of profiles) {
    for (const t of new Set([...p.genres, ...p.tags, ...p.buzzTags])) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = Math.max(1, profiles.length);
  const idf: IdfMap = new Map();
  const common = new Set<string>();
  for (const [t, count] of df) {
    idf.set(t, Math.log((n + 1) / (count + 1)) + 1e-3);
    if (n >= MIN_CATALOG_FOR_COMMON && count / n > COMMON_TERM_RATIO) common.add(t);
  }
  return { idf, common, maxIdf: Math.log(n + 1) };
}

const COMMON_TERM_RATIO = 0.1;
const MIN_CATALOG_FOR_COMMON = 50;

/** IDF-weighted Jaccard: shared rare terms count far more than shared generic ones. */
function weightedJaccard(a: Set<string>, b: Set<string>, idf: IdfMap | null, fallbackIdf: number): number {
  if (a.size === 0 || b.size === 0) return 0;
  const weight = (t: string) => (idf ? idf.get(t) ?? fallbackIdf : 1);
  let inter = 0;
  let union = 0;
  for (const t of a) {
    const w = weight(t);
    union += w;
    if (b.has(t)) inter += w;
  }
  for (const t of b) if (!a.has(t)) union += weight(t);
  return union > 0 ? inter / union : 0;
}

function overlaps<T>(a: Set<T>, b: Set<T>): number {
  for (const x of a) if (b.has(x)) return 1;
  return 0;
}

export const SIMILARITY_WEIGHTS = { genres: 3, tags: 1, buzzTags: 2, channel: 1, lang: 1 };
const SIMILARITY_TOTAL = Object.values(SIMILARITY_WEIGHTS).reduce((a, b) => a + b, 0);

/** Weighted content similarity in 0..1 between two series profiles. */
export function contentSimilarity(
  a: SimilarityProfile,
  b: SimilarityProfile,
  idf: IdfMap | null = null,
  fallbackIdf = 1
): number {
  const w = SIMILARITY_WEIGHTS;
  return (
    (w.genres * weightedJaccard(a.genres, b.genres, idf, fallbackIdf) +
      w.tags * weightedJaccard(a.tags, b.tags, idf, fallbackIdf) +
      w.buzzTags * weightedJaccard(a.buzzTags, b.buzzTags, idf, fallbackIdf) +
      w.channel * overlaps(a.channels, b.channels) +
      w.lang * overlaps(a.langs, b.langs)) /
    SIMILARITY_TOTAL
  );
}

/**
 * Requires a shared genre or tag that isn't catalog-wide boilerplate ("anime", "中文字幕").
 * Channel, language, and buzz-tag overlap alone are not a reason to recommend something.
 */
function sharesTopic(a: SimilarityProfile, b: SimilarityProfile, common: Set<string>): boolean {
  for (const t of a.genres) if (b.genres.has(t) && !common.has(t)) return true;
  for (const t of a.tags) if (b.tags.has(t) && !common.has(t)) return true;
  return false;
}

const MIN_SIMILARITY = 0.15;
const MAX_SEEDS = 5;

/**
 * "Because you watched X" rows. Seeds are ordered most-recent first; each candidate is
 * assigned to the seed row where its recency-weighted score is highest.
 */
export function queryForYou(
  db: DatabaseSync,
  opts: { seeds: string[]; exclude?: string[]; region?: string | null; perRow?: number }
): Array<{ seed: { slug: string; canonicalTitle: string }; items: SeriesListItem[] }> {
  const region = normalizeRegionCode(opts.region);
  const perRow = opts.perRow ?? 12;
  const seedSlugs = [...new Set(opts.seeds)].slice(0, MAX_SEEDS);
  if (seedSlugs.length === 0) return [];

  const seedRows = db
    .prepare(`${PROFILE_SELECT} WHERE s.slug IN (${seedSlugs.map(() => '?').join(',')})`)
    .all(...seedSlugs) as unknown as ProfileRow[];
  const seedBySlug = new Map(seedRows.map((r) => [r.slug, toProfile(r)]));
  const seeds = seedSlugs.map((s) => seedBySlug.get(s)).filter((x): x is SimilarityProfile => Boolean(x));
  if (seeds.length === 0) return [];

  const excluded = new Set([...seedSlugs, ...(opts.exclude || [])]);
  const elig = shelfEligibility(db, region);
  const candidates = (db.prepare(`${PROFILE_SELECT} WHERE ${elig.clause}`).all(...elig.params) as unknown as ProfileRow[])
    .filter((r) => !excluded.has(r.slug))
    .map(toProfile);

  const { idf, common, maxIdf } = buildIdf([...candidates, ...seeds]);
  const maxViewsLog = Math.log10(1 + Math.max(1, ...candidates.map((c) => c.totalViews)));
  const rowScores: Array<Array<{ id: number; score: number }>> = seeds.map(() => []);

  for (const cand of candidates) {
    const popularity = Math.log10(1 + cand.totalViews) / maxViewsLog;
    const buzz = Math.min(1, Math.max(0, cand.buzzScore / 100));
    let bestRow = -1;
    let bestWeighted = 0;
    let bestScore = 0;
    seeds.forEach((seed, i) => {
      if (!sharesTopic(seed, cand, common)) return;
      const sim = contentSimilarity(seed, cand, idf, maxIdf);
      if (sim < MIN_SIMILARITY) return;
      const score = 0.6 * sim + 0.25 * buzz + 0.15 * popularity;
      const weighted = score / (1 + 0.5 * i);
      if (weighted > bestWeighted) {
        bestWeighted = weighted;
        bestRow = i;
        bestScore = score;
      }
    });
    if (bestRow >= 0) rowScores[bestRow].push({ id: cand.id, score: bestScore });
  }

  return seeds
    .map((seed, i) => {
      const ranked = rowScores[i].sort((a, b) => b.score - a.score).slice(0, perRow * 3);
      const items = diversifyShelf(hydrateIds(db, ranked.map((r) => r.id), region), { limit: perRow });
      return { seed: { slug: seed.slug, canonicalTitle: seed.canonicalTitle }, items };
    })
    .filter((row) => row.items.length > 0);
}

const DAY = 86400;
export const TREND_WINDOW_DAYS = 7;
const MIN_BASELINE_DAYS = 2;
const MIN_TREND_DELTA = 500;

/** View velocity that doesn't just reward the biggest shows. */
export function trendScore(weeklyDelta: number, totalViews: number): number {
  return Math.log1p(Math.max(0, weeklyDelta)) - 0.5 * Math.log1p(Math.max(0, totalViews));
}

/**
 * Trending shelf: views gained over the last 7 days, measured against the newest snapshot
 * at least 7 days old (or, while history is short, the oldest snapshot at least 2 days old),
 * scaled to a 7-day window.
 */
export function queryTrending(
  db: DatabaseSync,
  limit = SHELF_SIZE,
  rawRegion?: string | null,
  now = Math.floor(Date.now() / 1000)
): SeriesListItem[] {
  const region = normalizeRegionCode(rawRegion);
  const elig = shelfEligibility(db, region);
  const windowStart = now - TREND_WINDOW_DAYS * DAY;
  const rows = db
    .prepare(
      `SELECT s.id, s.total_views,
              (SELECT v.total_views FROM series_view_snapshots v WHERE v.series_id = s.id AND v.captured_at <= ? ORDER BY v.captured_at DESC LIMIT 1) AS base_views,
              (SELECT MAX(v.captured_at) FROM series_view_snapshots v WHERE v.series_id = s.id AND v.captured_at <= ?) AS base_at,
              (SELECT v.total_views FROM series_view_snapshots v WHERE v.series_id = s.id ORDER BY v.captured_at ASC LIMIT 1) AS oldest_views,
              (SELECT MIN(v.captured_at) FROM series_view_snapshots v WHERE v.series_id = s.id) AS oldest_at
       FROM series s
       WHERE ${elig.clause}
         AND EXISTS (SELECT 1 FROM series_view_snapshots v WHERE v.series_id = s.id)`
    )
    .all(windowStart, windowStart, ...elig.params) as unknown as Array<{
    id: number;
    total_views: number;
    base_views: number | null;
    base_at: number | null;
    oldest_views: number | null;
    oldest_at: number | null;
  }>;

  const scored: Array<{ id: number; score: number }> = [];
  for (const r of rows) {
    let baseViews: number | null = null;
    let baseAt: number | null = null;
    if (r.base_at !== null && r.base_views !== null) {
      baseViews = r.base_views;
      baseAt = r.base_at;
    } else if (r.oldest_at !== null && r.oldest_views !== null && r.oldest_at <= now - MIN_BASELINE_DAYS * DAY) {
      baseViews = r.oldest_views;
      baseAt = r.oldest_at;
    }
    if (baseViews === null || baseAt === null) continue;
    const spanDays = Math.max(1, (now - baseAt) / DAY);
    const weeklyDelta = ((r.total_views - baseViews) * TREND_WINDOW_DAYS) / spanDays;
    if (weeklyDelta < MIN_TREND_DELTA) continue;
    scored.push({ id: r.id, score: trendScore(weeklyDelta, r.total_views) });
  }

  const ranked = scored.sort((a, b) => b.score - a.score).slice(0, limit * 3);
  return diversifyShelf(hydrateIds(db, ranked.map((r) => r.id), region), { limit });
}

export function queryUnlockedSeries(db: DatabaseSync, limit = SHELF_SIZE, rawRegion?: string | null): SeriesListItem[] {
  const region = normalizeRegionCode(rawRegion);
  const elig = shelfEligibility(db, region);
  const ids = (
    db
      .prepare(
        `SELECT s.id FROM series s
         WHERE s.unlocked_at IS NOT NULL AND ${elig.clause}
         ORDER BY s.unlocked_at DESC
         LIMIT ?`
      )
      .all(...elig.params, limit * 3) as unknown as Array<{ id: number }>
  ).map((r) => r.id);
  return diversifyShelf(hydrateIds(db, ids, region), { limit });
}

export function queryCommentRecommendations(db: DatabaseSync, rawRegion?: string | null) {
  const region = normalizeRegionCode(rawRegion);
  const elig = shelfEligibility(db, region);

  const pickIds = (
    db
      .prepare(
        `SELECT s.id FROM series s
         WHERE s.top_comment_quote IS NOT NULL AND s.buzz_score > 0 AND ${elig.clause}
         ORDER BY s.buzz_score DESC, s.total_views DESC
         LIMIT ?`
      )
      .all(...elig.params, SHELF_SIZE * 3) as unknown as Array<{ id: number }>
  ).map((r) => r.id);

  const gemIds = (
    db
      .prepare(
        `SELECT s.id FROM series s
         WHERE s.buzz_score > 0 AND s.total_views > 0 AND s.total_views < ${HIDDEN_GEM_MAX_VIEWS} AND ${elig.clause}
         ORDER BY s.buzz_score DESC
         LIMIT ?`
      )
      .all(...elig.params, SHELF_SIZE * 3) as unknown as Array<{ id: number }>
  ).map((r) => r.id);

  return {
    commentPicks: diversifyShelf(hydrateIds(db, pickIds, region)),
    hiddenGems: diversifyShelf(hydrateIds(db, gemIds, region)),
  };
}
