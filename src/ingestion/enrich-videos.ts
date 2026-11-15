import 'dotenv/config';
import { closeDatabase, openDatabase, rebuildAllFts, refreshSeriesStats } from '../db/index.ts';
import { fetchVideoDetailsMap, getSessionQuotaUnits } from '../lib/youtube.ts';
import { extractExpiryDate, isMembersOnlyPlaylist, isMembersOnlyText } from './title-parser.ts';

function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * 1) Purges all members-only episodes & ULTRA/member playlists from the public catalog,
 *    archiving their IDs into `locked_watch_pool` for future unlock tracking.
 * 2) Runs batched `videos.list` enrichment (50 videos = 1 quota unit) to populate
 *    `view_count`, `like_count`, `comment_count`, `published_at`, `duration_iso`, `tags`,
 *    and drop any hidden members-only videos missing `statistics.viewCount`.
 */
export async function runEnrichVideos(limit = 15000) {
  const db = openDatabase();

  // Step 1: Purge known members-only playlists & episodes into locked_watch_pool
  const memberPlaylists = db
    .prepare('SELECT id, channel_id, playlist_id, playlist_title, sub_language FROM channel_series')
    .all() as unknown as Array<{
    id: number;
    channel_id: number;
    playlist_id: string;
    playlist_title: string;
    sub_language: string;
  }>;

  const memberCsIds = memberPlaylists
    .filter((cs) => isMembersOnlyPlaylist(cs.playlist_title))
    .map((cs) => cs.id);

  const memberEpisodes = db
    .prepare(
      `SELECT e.id, e.youtube_video_id, e.channel_id, e.title, e.sub_language,
              cs.playlist_id, cs.playlist_title
       FROM episodes e
       JOIN channel_series cs ON cs.id = e.channel_series_id
       WHERE e.is_members_only = 1`
    )
    .all() as unknown as Array<{
    id: number;
    youtube_video_id: string;
    channel_id: number;
    title: string;
    sub_language: string;
    playlist_id: string;
    playlist_title: string;
  }>;

  const insertLocked = db.prepare(
    `INSERT INTO locked_watch_pool (youtube_video_id, channel_id, playlist_id, playlist_title, title, sub_language, detected_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(youtube_video_id) DO NOTHING`
  );

  db.exec('BEGIN');
  try {
    for (const ep of memberEpisodes) {
      insertLocked.run(
        ep.youtube_video_id,
        ep.channel_id,
        ep.playlist_id,
        ep.playlist_title,
        ep.title,
        ep.sub_language,
        'members_episode_purge'
      );
    }

    if (memberCsIds.length > 0) {
      const ph = memberCsIds.map(() => '?').join(',');
      const playlistEps = db
        .prepare(
          `SELECT e.youtube_video_id, e.channel_id, e.title, e.sub_language, cs.playlist_id, cs.playlist_title
           FROM episodes e
           JOIN channel_series cs ON cs.id = e.channel_series_id
           WHERE e.channel_series_id IN (${ph})`
        )
        .all(...memberCsIds) as unknown as Array<{
        youtube_video_id: string;
        channel_id: number;
        title: string;
        sub_language: string;
        playlist_id: string;
        playlist_title: string;
      }>;
      for (const ep of playlistEps) {
        insertLocked.run(
          ep.youtube_video_id,
          ep.channel_id,
          ep.playlist_id,
          ep.playlist_title,
          ep.title,
          ep.sub_language,
          'members_playlist_purge'
        );
      }
      db.prepare(`DELETE FROM channel_series WHERE id IN (${ph})`).run(...memberCsIds);
    }

    db.exec('DELETE FROM episodes WHERE is_members_only = 1');
    db.exec(`
      UPDATE channel_series
      SET episode_count = (SELECT COUNT(*) FROM episodes e WHERE e.channel_series_id = channel_series.id),
          access_note = 'free'
    `);
    db.exec('DELETE FROM channel_series WHERE episode_count = 0');
    db.exec('DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM channel_series)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(
    `Purged ${memberCsIds.length} member-only playlists and ${memberEpisodes.length} members-only episodes into locked_watch_pool.`
  );

  // Step 2: Enrich missing video details (prioritize Episode 1 and early positions across all series first!)
  const pendingRows = db
    .prepare(
      `SELECT DISTINCT youtube_video_id
       FROM episodes
       WHERE details_synced_at IS NULL
       ORDER BY CASE WHEN episode_number <= 1 OR playlist_position = 0 THEN 0 ELSE 1 END ASC,
                playlist_position ASC
       LIMIT ?`
    )
    .all(limit) as unknown as Array<{ youtube_video_id: string }>;

  const videoIds = pendingRows.map((r) => r.youtube_video_id);
  console.log(`Fetching YouTube details (views, upload date, duration, tags) for ${videoIds.length} videos...`);

  const touchedSeries = new Set<number>();
  let enrichedCount = 0;
  let apiLockedRemoved = 0;
  let abortedError: unknown = null;

  // Process in chunks of 500 so progress is saved incrementally even if interrupted
  try {
    for (let i = 0; i < videoIds.length; i += 500) {
      const batch = videoIds.slice(i, i + 500);
      const detailsMap = await fetchVideoDetailsMap(batch);

      const updateStmt = db.prepare(
        `UPDATE episodes
         SET duration_iso = COALESCE(?, duration_iso),
             view_count = ?,
             like_count = ?,
             comment_count = ?,
             tags = ?,
             description = COALESCE(?, description),
             published_at = COALESCE(?, published_at),
             expires_at = COALESCE(?, expires_at),
             region_allowed = ?,
             region_blocked = ?,
             details_synced_at = unixepoch()
         WHERE youtube_video_id = ?`
      );

      const findEpMeta = db.prepare(
        `SELECT e.series_id, e.channel_id, e.title, e.sub_language, cs.playlist_id, cs.playlist_title
         FROM episodes e
         JOIN channel_series cs ON cs.id = e.channel_series_id
         WHERE e.youtube_video_id = ?`
      );
      const deleteVideo = db.prepare('DELETE FROM episodes WHERE youtube_video_id = ?');

      db.exec('BEGIN');
      try {
        for (const vid of batch) {
          const d = detailsMap.get(vid);
          const rows = findEpMeta.all(vid) as unknown as Array<{
            series_id: number;
            channel_id: number;
            title: string;
            sub_language: string;
            playlist_id: string;
            playlist_title: string;
          }>;
          for (const r of rows) touchedSeries.add(r.series_id);

          if (!d || d.isMembersOnly || !d.embeddable || isMembersOnlyText(`${d.title} ${d.description}`)) {
            if (rows[0]) {
              insertLocked.run(
                vid,
                rows[0].channel_id,
                rows[0].playlist_id,
                rows[0].playlist_title,
                d?.title || rows[0].title,
                rows[0].sub_language,
                !d ? 'unavailable_or_private' : !d.embeddable ? 'embedding_disabled' : 'api_members_or_viewcount_missing'
              );
            }
            deleteVideo.run(vid);
            apiLockedRemoved++;
            continue;
          }

          updateStmt.run(
            d.durationIso,
            d.viewCount,
            d.likeCount,
            d.commentCount,
            JSON.stringify(d.tags.slice(0, 15)),
            d.description ? d.description.slice(0, 2000) : null,
            toUnixSeconds(d.publishedAt),
            extractExpiryDate(d.description),
            d.regionAllowed.length > 0 ? JSON.stringify(d.regionAllowed) : null,
            d.regionBlocked.length > 0 ? JSON.stringify(d.regionBlocked) : null,
            vid
          );
          enrichedCount++;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      console.log(`  Processed ${Math.min(i + batch.length, videoIds.length)}/${videoIds.length} (enriched: ${enrichedCount}, removed locked/unavailable: ${apiLockedRemoved})`);
    }
  } catch (err) {
    abortedError = err;
    console.warn(`\nStopped early (${err instanceof Error ? err.message : String(err)}). Refreshing series stats for committed batches...`);
  } finally {
    // Clean up any empty channel_series or series after API verification
    db.exec(`
      UPDATE channel_series
      SET episode_count = (SELECT COUNT(*) FROM episodes e WHERE e.channel_series_id = channel_series.id);
      DELETE FROM channel_series WHERE episode_count = 0;
      DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM channel_series);
    `);

    const allSeries = db.prepare('SELECT id FROM series').all() as unknown as Array<{ id: number }>;
    for (const s of allSeries) {
      refreshSeriesStats(db, s.id);
    }
    rebuildAllFts(db);
  }

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM series WHERE episode_count > 0) AS sr,
              (SELECT COUNT(*) FROM episodes) AS ep,
              (SELECT COUNT(*) FROM locked_watch_pool) AS locked`
    )
    .get() as { sr: number; ep: number; locked: number };

  console.log(
    `\nEnrichment complete: ${enrichedCount} enriched, ${apiLockedRemoved} locked/unavailable removed. Catalog: ${stats.sr} free series | ${stats.ep} free episodes | ${stats.locked} in locked_watch_pool. Quota used: ~${getSessionQuotaUnits()} units.`
  );
  closeDatabase();
  if (abortedError) throw abortedError;
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('enrich-videos.ts');
if (isDirect) {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = process.argv.includes('--all')
    ? 200000
    : limitArg
      ? parseInt(limitArg.split('=')[1], 10) || 15000
      : 15000;
  runEnrichVideos(limit).catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
