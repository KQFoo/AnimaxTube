import 'dotenv/config';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../db/index.ts';
import { fetchVideoComments, getSessionQuotaUnits } from '../lib/youtube.ts';
import { buildEngagementModel, scoreCommentsForRecommendation } from './title-parser.ts';

const EP1_VIDEO_SQL = `(SELECT e.youtube_video_id FROM episodes e
   WHERE e.series_id = s.id AND e.is_members_only = 0
   ORDER BY CASE WHEN e.episode_number = 1 THEN 0 ELSE 1 END ASC, e.episode_number ASC, e.playlist_position ASC
   LIMIT 1)`;

function loadEngagementModel(db: DatabaseSync) {
  const samples = db
    .prepare(
      `SELECT e.view_count AS viewCount, COALESCE(e.like_count, 0) AS likeCount, COALESCE(e.comment_count, 0) AS commentCount
       FROM series s
       JOIN episodes e ON e.youtube_video_id = ${EP1_VIDEO_SQL}
       WHERE s.episode_count > 0 AND e.view_count > 0`
    )
    .all() as unknown as Array<{ viewCount: number; likeCount: number; commentCount: number }>;
  return buildEngagementModel(samples);
}

export interface CommentCandidate {
  series_id: number;
  canonical_title: string;
  ep1_video_id: string;
  ep1_views: number;
  ep1_likes: number;
  ep1_comments: number;
}

export const RESCORE_AFTER_SECONDS = 30 * 86400;
const HIDDEN_GEM_MAX_VIEWS = 500_000;
const GEM_VIEW_BANDS: Array<[number, number]> = [
  [1, 10_000],
  [10_000, 50_000],
  [50_000, 150_000],
  [150_000, HIDDEN_GEM_MAX_VIEWS],
];

/**
 * Picks series to (re)score: 40% most-viewed, 40% a view-band-stratified sample of
 * smaller series (Hidden Gem pool), 20% recently uploaded/unlocked. Only series never
 * scored or scored more than 30 days ago are eligible.
 */
export function selectCommentCandidates(db: DatabaseSync, limit: number, now = Math.floor(Date.now() / 1000)) {
  const staleBefore = now - RESCORE_AFTER_SECONDS;
  const base = `SELECT s.id AS series_id, s.canonical_title,
              e.youtube_video_id AS ep1_video_id,
              COALESCE(e.view_count, 0) AS ep1_views,
              COALESCE(e.like_count, 0) AS ep1_likes,
              COALESCE(e.comment_count, 0) AS ep1_comments
       FROM series s
       JOIN episodes e ON e.youtube_video_id = ${EP1_VIDEO_SQL}
       WHERE s.episode_count > 0 AND (s.buzz_scored_at IS NULL OR s.buzz_scored_at < ?)`;

  const chosen = new Map<number, CommentCandidate>();
  const take = (filterAndOrder: string, params: Array<number>, n: number) => {
    if (n <= 0) return;
    const rows = db
      .prepare(`${base} ${filterAndOrder} LIMIT ?`)
      .all(staleBefore, ...params, n + chosen.size) as unknown as CommentCandidate[];
    let added = 0;
    for (const r of rows) {
      if (added >= n) break;
      if (chosen.has(r.series_id)) continue;
      chosen.set(r.series_id, r);
      added++;
    }
  };

  const topQuota = Math.round(limit * 0.4);
  const gemQuota = Math.round(limit * 0.4);
  const recentQuota = limit - topQuota - gemQuota;

  take('AND s.total_views > 0 ORDER BY s.total_views DESC', [], topQuota);

  const perBand = Math.ceil(gemQuota / GEM_VIEW_BANDS.length);
  for (const [lo, hi] of GEM_VIEW_BANDS) {
    const remaining = topQuota + gemQuota - chosen.size;
    take(
      'AND s.episode_count >= 3 AND s.total_views >= ? AND s.total_views < ? ORDER BY RANDOM()',
      [lo, hi],
      Math.min(perBand, remaining)
    );
  }

  take(
    'AND COALESCE(s.unlocked_at, s.latest_uploaded_at, 0) >= ? ORDER BY COALESCE(s.unlocked_at, s.latest_uploaded_at) DESC',
    [now - RESCORE_AFTER_SECONDS],
    recentQuota
  );

  // Top up from the most-viewed pool when a bucket ran short.
  take('AND s.total_views > 0 ORDER BY s.total_views DESC', [], limit - chosen.size);

  return [...chosen.values()];
}

export async function runEnrichComments(limit = 100) {
  const db = openDatabase();
  const model = loadEngagementModel(db);
  const candidates = selectCommentCandidates(db, limit);

  console.log(
    `Mining spoiler-safe Episode-1 comments for ${candidates.length} series (global engagement rate ${model.globalRate.toFixed(4)})...`
  );
  const updateStmt = db.prepare(
    `UPDATE series
     SET buzz_score = ?,
         buzz_tags = ?,
         top_comment_quote = ?,
         top_comment_author = ?,
         top_comment_likes = ?,
         buzz_scored_at = unixepoch()
     WHERE id = ?`
  );

  let updated = 0;
  for (const row of candidates) {
    const comments = await fetchVideoComments(row.ep1_video_id, 25);
    const scored = scoreCommentsForRecommendation(
      comments,
      { viewCount: row.ep1_views, likeCount: row.ep1_likes, commentCount: row.ep1_comments },
      model
    );
    updateStmt.run(
      scored.buzzScore,
      JSON.stringify(scored.buzzTags),
      scored.topCommentQuote,
      scored.topCommentAuthor,
      scored.topCommentLikes,
      row.series_id
    );
    if (scored.topCommentQuote) updated++;
  }

  console.log(
    `Comment recommendation enrichment finished: ${updated}/${candidates.length} series scored with spoiler-safe quotes. Quota used: ~${getSessionQuotaUnits()} units.`
  );
  closeDatabase();
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('enrich-comments.ts');
if (isDirect) {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 100 : 100;
  runEnrichComments(limit).catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
