import type { DatabaseSync } from 'node:sqlite';
import { buildEpisodeGeoSql, buildLiveGeoSql, normalizeRegionCode, parseJsonArray } from './index.ts';

const DAY_SEC = 86400;
const WEEK_SEC = 7 * DAY_SEC;
const RECENT_ACTIVE_WINDOW_SEC = 21 * DAY_SEC;
const MAX_FORECAST_HORIZON_SEC = 21 * DAY_SEC;
const DEDUP_WINDOW_SEC = 36 * 3600;
const BATCH_GROUP_WINDOW_SEC = 6 * 3600;

export type CalendarItemStatus = 'released' | 'live' | 'upcoming';
export type CalendarConfidence = 'exact' | 'estimated';

export interface CalendarItem {
  id: string;
  kind: 'episode' | 'premiere' | 'predicted';
  status: CalendarItemStatus;
  confidence: CalendarConfidence;
  airingAt: number;
  seriesId: number | null;
  seriesSlug: string | null;
  seriesTitle: string;
  posterUrl: string | null;
  thumbnailUrl: string | null;
  episodeNumber: number | null;
  episodeNumberEnd?: number | null;
  batchCount?: number;
  episodeTitle: string | null;
  youtubeVideoId: string | null;
  durationIso: string | null;
  buzzScore: number;
  channelId: number;
  channelName: string;
  channelAvatar: string | null;
  subLanguage: string;
}

export interface CalendarQueryOptions {
  region?: string | null;
  lang?: string;
  channelId?: number;
  startSec?: number;
  endSec?: number;
  nowSec?: number;
}

function matchesLangFilter(subLanguage: string, lang: string): boolean {
  if (!lang || lang === 'all') return true;
  if (lang === 'en') return subLanguage === 'en' || subLanguage === 'multi';
  if (lang === 'zh') return subLanguage === 'zh-Hant' || subLanguage === 'zh-Hans' || subLanguage === 'multi';
  return true;
}

function normalizePrimarySubLang(subLanguagesJson: string): string {
  const langs = parseJsonArray(subLanguagesJson);
  if (langs.includes('en') && (langs.includes('zh-Hant') || langs.includes('zh-Hans'))) return 'multi';
  return langs[0] || 'en';
}

function isWeeklyInterval(dt: number): boolean {
  return dt >= 6 * DAY_SEC && dt <= 8.5 * DAY_SEC;
}

/**
 * Computes weekly anime release calendar purely from YouTube channel data:
 * 1. Actual published episodes within [startSec, endSec)
 * 2. Live & upcoming YouTube Premieres / scheduled streams from `live_streams`
 * 3. Predicted weekly YouTube drops inferred from recent weekly episode upload cadence
 *
 * All timestamps are UTC unix seconds so the client renders them in the user's local timezone.
 */
export function queryCalendar(db: DatabaseSync, opts: CalendarQueryOptions = {}): {
  startSec: number;
  endSec: number;
  region: string | null;
  items: CalendarItem[];
} {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const defaultStart = Math.floor(nowSec / DAY_SEC) * DAY_SEC - 3 * DAY_SEC;
  const startSec = Number.isFinite(opts.startSec) ? Math.floor(opts.startSec!) : defaultStart;
  const rawEnd = Number.isFinite(opts.endSec) ? Math.floor(opts.endSec!) : startSec + WEEK_SEC;
  const endSec = Math.min(startSec + 14 * DAY_SEC, Math.max(startSec + DAY_SEC, rawEnd));

  const region = normalizeRegionCode(opts.region);
  const lang = opts.lang || 'all';
  const channelId = opts.channelId && opts.channelId > 0 ? opts.channelId : null;

  const items: CalendarItem[] = [];
  const coveredKeys: Array<{ channelId: number; seriesId: number; airingAt: number }> = [];

  // 1. Released episodes inside [startSec, endSec)
  const geoEp = buildEpisodeGeoSql(db, 'e', region);
  const epWhere: string[] = [
    'e.is_members_only = 0',
    'e.published_at IS NOT NULL',
    'e.published_at >= ?',
    'e.published_at < ?',
    'c.is_verified = 1',
    geoEp.sql,
  ];
  const epParams: Array<string | number> = [startSec, endSec, ...geoEp.params];

  if (channelId) {
    epWhere.push('e.channel_id = ?');
    epParams.push(channelId);
  }
  if (lang === 'en') {
    epWhere.push("e.sub_language IN ('en', 'multi')");
  } else if (lang === 'zh') {
    epWhere.push("e.sub_language IN ('zh-Hant', 'zh-Hans', 'multi')");
  }

  const releasedRows = db
    .prepare(
      `SELECT e.id, e.series_id, e.channel_id, e.youtube_video_id, e.title AS ep_title,
              e.episode_number, e.sub_language, e.duration_iso, e.thumbnail_url, e.published_at,
              s.slug, s.canonical_title, s.poster_url, s.buzz_score,
              c.name AS channel_name, c.avatar_url AS channel_avatar
       FROM episodes e
       JOIN series s ON s.id = e.series_id
       JOIN channels c ON c.id = e.channel_id
       WHERE ${epWhere.join(' AND ')}
       ORDER BY e.published_at ASC`
    )
    .all(...epParams) as unknown as Array<{
    id: number;
    series_id: number;
    channel_id: number;
    youtube_video_id: string;
    ep_title: string;
    episode_number: number | null;
    sub_language: string;
    duration_iso: string | null;
    thumbnail_url: string | null;
    published_at: number;
    slug: string;
    canonical_title: string;
    poster_url: string | null;
    buzz_score: number;
    channel_name: string;
    channel_avatar: string | null;
  }>;

  // Collapse same-series/same-channel batch drops within BATCH_GROUP_WINDOW_SEC into one card
  type ReleasedRow = (typeof releasedRows)[number];
  const releasedBatches: ReleasedRow[][] = [];
  const activeBatchMap = new Map<string, ReleasedRow[]>();

  for (const r of releasedRows) {
    coveredKeys.push({ channelId: r.channel_id, seriesId: r.series_id, airingAt: r.published_at });
    const batchKey = `${r.channel_id}:${r.series_id}:${r.sub_language}`;
    const current = activeBatchMap.get(batchKey);
    if (current && r.published_at - current[0].published_at <= BATCH_GROUP_WINDOW_SEC) {
      current.push(r);
    } else {
      const nextBatch = [r];
      releasedBatches.push(nextBatch);
      activeBatchMap.set(batchKey, nextBatch);
    }
  }

  for (const batch of releasedBatches) {
    if (batch.length === 1) {
      const r = batch[0];
      items.push({
        id: `ep:${r.id}`,
        kind: 'episode',
        status: 'released',
        confidence: 'exact',
        airingAt: r.published_at,
        seriesId: r.series_id,
        seriesSlug: r.slug,
        seriesTitle: r.canonical_title,
        posterUrl: r.poster_url,
        thumbnailUrl: r.thumbnail_url || r.poster_url,
        episodeNumber: r.episode_number,
        episodeTitle: r.ep_title,
        youtubeVideoId: r.youtube_video_id,
        durationIso: r.duration_iso,
        buzzScore: r.buzz_score || 0,
        channelId: r.channel_id,
        channelName: r.channel_name,
        channelAvatar: r.channel_avatar,
        subLanguage: r.sub_language,
      });
      continue;
    }

    const sorted = [...batch].sort(
      (a, b) => (a.episode_number ?? Number.MAX_SAFE_INTEGER) - (b.episode_number ?? Number.MAX_SAFE_INTEGER) || a.published_at - b.published_at
    );
    const first = sorted[0];
    const epNums = sorted.map((x) => x.episode_number).filter((n): n is number => n !== null);
    const minEp = epNums.length > 0 ? Math.min(...epNums) : null;
    const maxEp = epNums.length > 0 ? Math.max(...epNums) : null;
    const batchTitle =
      minEp !== null && maxEp !== null && minEp !== maxEp
        ? `EP ${minEp}–${maxEp} (${batch.length} episodes)`
        : `${batch.length} episodes dropped`;

    items.push({
      id: `ep:${first.id}`,
      kind: 'episode',
      status: 'released',
      confidence: 'exact',
      airingAt: batch[0].published_at,
      seriesId: first.series_id,
      seriesSlug: first.slug,
      seriesTitle: first.canonical_title,
      posterUrl: first.poster_url,
      thumbnailUrl: first.thumbnail_url || first.poster_url,
      episodeNumber: minEp,
      episodeNumberEnd: maxEp !== minEp ? maxEp : null,
      batchCount: batch.length,
      episodeTitle: batchTitle,
      youtubeVideoId: first.youtube_video_id,
      durationIso: first.duration_iso,
      buzzScore: first.buzz_score || 0,
      channelId: first.channel_id,
      channelName: first.channel_name,
      channelAvatar: first.channel_avatar,
      subLanguage: first.sub_language,
    });
  }

  // 2. Live and upcoming YouTube Premieres / scheduled streams from `live_streams`
  const geoLs = buildLiveGeoSql(db, 'ls', region);
  const lsWhere: string[] = [
    "ls.status IN ('live', 'upcoming')",
    'c.is_verified = 1',
    'COALESCE(ls.scheduled_start_at, ls.started_at, ls.checked_at) >= ?',
    'COALESCE(ls.scheduled_start_at, ls.started_at, ls.checked_at) < ?',
    geoLs.sql,
  ];
  const lsParams: Array<string | number> = [startSec, endSec, ...geoLs.params];
  if (channelId) {
    lsWhere.push('ls.channel_id = ?');
    lsParams.push(channelId);
  }

  const liveRows = db
    .prepare(
      `SELECT ls.*, c.name AS channel_name, c.avatar_url AS channel_avatar, c.sub_languages
       FROM live_streams ls
       JOIN channels c ON c.id = ls.channel_id
       WHERE ${lsWhere.join(' AND ')}
       ORDER BY COALESCE(ls.scheduled_start_at, ls.started_at, ls.checked_at) ASC`
    )
    .all(...lsParams) as unknown as Array<{
    id: number;
    youtube_video_id: string;
    channel_id: number;
    title: string;
    thumbnail_url: string | null;
    status: 'live' | 'upcoming';
    started_at: number | null;
    scheduled_start_at: number | null;
    checked_at: number;
    channel_name: string;
    channel_avatar: string | null;
    sub_languages: string;
  }>;

  const seenVideoIds = new Set(releasedRows.map((r) => r.youtube_video_id));

  for (const ls of liveRows) {
    if (seenVideoIds.has(ls.youtube_video_id)) continue;
    const subLanguage = normalizePrimarySubLang(ls.sub_languages);
    if (!matchesLangFilter(subLanguage, lang)) continue;
    const airingAt = ls.scheduled_start_at || ls.started_at || ls.checked_at;
    items.push({
      id: `live:${ls.youtube_video_id}`,
      kind: 'premiere',
      status: ls.status === 'live' ? 'live' : 'upcoming',
      confidence: 'exact',
      airingAt,
      seriesId: null,
      seriesSlug: null,
      seriesTitle: ls.title,
      posterUrl: ls.thumbnail_url,
      thumbnailUrl: ls.thumbnail_url,
      episodeNumber: null,
      episodeTitle: ls.title,
      youtubeVideoId: ls.youtube_video_id,
      durationIso: null,
      buzzScore: 0,
      channelId: ls.channel_id,
      channelName: ls.channel_name,
      channelAvatar: ls.channel_avatar,
      subLanguage,
    });
  }

  // 3. Predicted weekly YouTube drops from recent active series upload cadence
  const forecastEnd = Math.min(endSec, nowSec + MAX_FORECAST_HORIZON_SEC);
  if (forecastEnd > nowSec) {
    const activeCutoff = nowSec - RECENT_ACTIVE_WINDOW_SEC;
    const geoPred = buildEpisodeGeoSql(db, 'e', region);
    const predWhere: string[] = [
      'e.is_members_only = 0',
      'e.published_at IS NOT NULL',
      'e.published_at >= ?',
      'c.is_verified = 1',
      '(s.expires_at IS NULL OR s.expires_at > ?)',
      geoPred.sql,
    ];
    const predParams: Array<string | number> = [activeCutoff - 2 * WEEK_SEC, nowSec, ...geoPred.params];

    if (channelId) {
      predWhere.push('e.channel_id = ?');
      predParams.push(channelId);
    }
    if (lang === 'en') {
      predWhere.push("cs.sub_language IN ('en', 'multi')");
    } else if (lang === 'zh') {
      predWhere.push("cs.sub_language IN ('zh-Hant', 'zh-Hans', 'multi')");
    }

    const recentEpisodes = db
      .prepare(
        `SELECT e.channel_series_id, e.series_id, e.channel_id, e.episode_number, e.published_at,
                e.thumbnail_url, cs.sub_language,
                s.slug, s.canonical_title, s.poster_url, s.buzz_score,
                c.name AS channel_name, c.avatar_url AS channel_avatar
         FROM episodes e
         JOIN channel_series cs ON cs.id = e.channel_series_id
         JOIN series s ON s.id = e.series_id
         JOIN channels c ON c.id = e.channel_id
         WHERE ${predWhere.join(' AND ')}
         ORDER BY e.channel_series_id ASC, e.published_at DESC`
      )
      .all(...predParams) as unknown as Array<{
      channel_series_id: number;
      series_id: number;
      channel_id: number;
      episode_number: number | null;
      published_at: number;
      thumbnail_url: string | null;
      sub_language: string;
      slug: string;
      canonical_title: string;
      poster_url: string | null;
      buzz_score: number;
      channel_name: string;
      channel_avatar: string | null;
    }>;

    const byCs = new Map<number, typeof recentEpisodes>();
    for (const row of recentEpisodes) {
      const list = byCs.get(row.channel_series_id) || [];
      if (list.length < 6) list.push(row);
      byCs.set(row.channel_series_id, list);
    }

    for (const [csId, eps] of byCs) {
      if (eps.length < 2) continue;
      const latest = eps[0];
      if (latest.published_at < activeCutoff) continue;

      // Verify weekly upload cadence from recent consecutive episode intervals
      let weeklyCount = 0;
      let totalIntervals = 0;
      for (let i = 0; i < eps.length - 1 && i < 4; i++) {
        const dt = eps[i].published_at - eps[i + 1].published_at;
        // Skip same-day batch drops when checking weekly rhythm
        if (dt < 600) continue;
        totalIntervals++;
        if (isWeeklyInterval(dt)) weeklyCount++;
      }
      if (totalIntervals === 0 || weeklyCount === 0 || weeklyCount / totalIntervals < 0.5) continue;

      // Project weekly slot forward into [Math.max(startSec, nowSec), forecastEnd)
      let candidateAt = latest.published_at + WEEK_SEC;
      let step = 1;
      while (candidateAt < Math.max(startSec, nowSec)) {
        candidateAt += WEEK_SEC;
        step++;
      }

      while (candidateAt < forecastEnd) {
        const isDuplicate = coveredKeys.some(
          (c) =>
            c.channelId === latest.channel_id &&
            c.seriesId === latest.series_id &&
            Math.abs(c.airingAt - candidateAt) <= DEDUP_WINDOW_SEC
        );
        if (!isDuplicate) {
          const nextEpNum = latest.episode_number !== null ? latest.episode_number + step : null;
          items.push({
            id: `pred:${csId}:${candidateAt}`,
            kind: 'predicted',
            status: 'upcoming',
            confidence: 'estimated',
            airingAt: candidateAt,
            seriesId: latest.series_id,
            seriesSlug: latest.slug,
            seriesTitle: latest.canonical_title,
            posterUrl: latest.poster_url || latest.thumbnail_url,
            thumbnailUrl: latest.poster_url || latest.thumbnail_url,
            episodeNumber: nextEpNum,
            episodeTitle: nextEpNum !== null ? `Episode ${nextEpNum} (Est.)` : 'New Episode (Est.)',
            youtubeVideoId: null,
            durationIso: null,
            buzzScore: latest.buzz_score || 0,
            channelId: latest.channel_id,
            channelName: latest.channel_name,
            channelAvatar: latest.channel_avatar,
            subLanguage: latest.sub_language,
          });
        }
        candidateAt += WEEK_SEC;
        step++;
      }
    }
  }

  items.sort((a, b) => a.airingAt - b.airingAt || b.buzzScore - a.buzzScore);
  return { startSec, endSec, region, items };
}
