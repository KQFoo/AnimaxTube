import 'dotenv/config';
import { closeDatabase, ensureUniqueSlug, openDatabase, refreshSeriesStats } from '../db/index.ts';
import type { ChannelRow } from '../db/schema.ts';
import {
  fetchChannelRssFeed,
  fetchVideoDetailsMap,
  getSessionQuotaUnits,
  probeChannelLiveVideoId,
} from '../lib/youtube.ts';
import {
  cleanSeriesTitle,
  extractEpisodeNumber,
  extractExpiryDate,
  isMembersOnlyText,
  normalizeSeriesKey,
} from '../ingestion/title-parser.ts';

function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Real-time tracker for:
 * 1. Active Live Anime Marathons & Premieres (via 0-quota /live probe + RSS feed + videos.list liveStreamingDetails)
 * 2. Newly Unlocked Member-Only Anime (diffs `locked_watch_pool` via 1-unit/50-videos batches)
 */
export async function runLiveAndUnlockTracker(opts: { lockedCheckLimit?: number } = {}) {
  const db = openDatabase();
  const channels = db
    .prepare('SELECT * FROM channels WHERE is_verified = 1')
    .all() as unknown as ChannelRow[];

  console.log(`Checking ${channels.length} channels for live anime marathons & recent RSS uploads (0 quota)...`);
  const liveCandidateMap = new Map<string, number>(); // videoId -> channel.id
  const rssNewVideoMap = new Map<string, { channel: ChannelRow; title: string }>();

  const knownVideoCheck = db.prepare('SELECT 1 FROM episodes WHERE youtube_video_id = ? LIMIT 1');

  // Step 1: 0-quota /live probes + RSS feed scans (parallelized in small batches)
  for (let i = 0; i < channels.length; i += 6) {
    const slice = channels.slice(i, i + 6);
    await Promise.all(
      slice.map(async (ch) => {
        const [liveVid, rssEntries] = await Promise.all([
          probeChannelLiveVideoId(ch.youtube_channel_id),
          fetchChannelRssFeed(ch.youtube_channel_id),
        ]);
        if (liveVid) liveCandidateMap.set(liveVid, ch.id);
        for (const entry of rssEntries) {
          if (/live|馬拉松|marathon|premiere/i.test(entry.title)) {
            liveCandidateMap.set(entry.videoId, ch.id);
          }
          if (!knownVideoCheck.get(entry.videoId)) {
            rssNewVideoMap.set(entry.videoId, { channel: ch, title: entry.title });
          }
        }
      })
    );
  }

  // Mark previously live streams as ended unless confirmed live below
  db.exec("UPDATE live_streams SET status = 'ended' WHERE status IN ('live', 'upcoming')");

  // Step 2: Check live candidates + new RSS uploads via batched videos.list (1 unit per 50 IDs)
  const checkIds = [...new Set([...liveCandidateMap.keys(), ...rssNewVideoMap.keys()])];
  let liveCount = 0;
  if (checkIds.length > 0) {
    const details = await fetchVideoDetailsMap(checkIds);
    const upsertLive = db.prepare(
      `INSERT INTO live_streams (
        youtube_video_id, channel_id, title, thumbnail_url, status,
        concurrent_viewers, started_at, scheduled_start_at, region_allowed, region_blocked, checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(youtube_video_id) DO UPDATE SET
        title = excluded.title,
        thumbnail_url = COALESCE(excluded.thumbnail_url, live_streams.thumbnail_url),
        status = excluded.status,
        concurrent_viewers = excluded.concurrent_viewers,
        started_at = COALESCE(excluded.started_at, live_streams.started_at),
        scheduled_start_at = COALESCE(excluded.scheduled_start_at, live_streams.scheduled_start_at),
        region_allowed = excluded.region_allowed,
        region_blocked = excluded.region_blocked,
        checked_at = unixepoch()`
    );

    for (const [vid, d] of details) {
      if (d.liveBroadcastContent === 'live' || d.liveBroadcastContent === 'upcoming') {
        const chId = liveCandidateMap.get(vid) || rssNewVideoMap.get(vid)?.channel.id;
        if (!chId) continue;
        upsertLive.run(
          vid,
          chId,
          d.title,
          d.thumbnailUrl,
          d.liveBroadcastContent,
          d.concurrentViewers,
          toUnixSeconds(d.actualStartTime),
          toUnixSeconds(d.scheduledStartTime),
          d.regionAllowed.length > 0 ? JSON.stringify(d.regionAllowed) : null,
          d.regionBlocked.length > 0 ? JSON.stringify(d.regionBlocked) : null
        );
        if (d.liveBroadcastContent === 'live') liveCount++;
      }
    }
  }

  // Step 3: Check a batch from locked_watch_pool for newly unlocked public free videos
  const lockedLimit = opts.lockedCheckLimit ?? 500;
  const lockedRows = db
    .prepare(
      `SELECT * FROM locked_watch_pool
       ORDER BY COALESCE(last_checked_at, 0) ASC
       LIMIT ?`
    )
    .all(lockedLimit) as unknown as Array<{
    youtube_video_id: string;
    channel_id: number;
    playlist_id: string | null;
    playlist_title: string | null;
    title: string;
    sub_language: string;
  }>;

  let unlockedCount = 0;
  if (lockedRows.length > 0) {
    const lockedIds = lockedRows.map((r) => r.youtube_video_id);
    const details = await fetchVideoDetailsMap(lockedIds);
    const markChecked = db.prepare('UPDATE locked_watch_pool SET last_checked_at = unixepoch() WHERE youtube_video_id = ?');
    const removeLocked = db.prepare('DELETE FROM locked_watch_pool WHERE youtube_video_id = ?');

    for (const row of lockedRows) {
      const d = details.get(row.youtube_video_id);
      if (!d || d.isMembersOnly || isMembersOnlyText(`${d.title} ${d.description}`)) {
        markChecked.run(row.youtube_video_id);
        continue;
      }

      // Newly unlocked! Promote into free series/episodes with unlocked_at + expiry date
      const rawSeriesTitle = row.playlist_title || d.title;
      const cleaned = cleanSeriesTitle(rawSeriesTitle);
      const normKey = normalizeSeriesKey(cleaned);

      let seriesRow = db
        .prepare('SELECT id FROM series WHERE normalized_key = ? LIMIT 1')
        .get(normKey) as { id: number } | undefined;

      if (!seriesRow) {
        const slug = ensureUniqueSlug(db, cleaned);
        const ins = db
          .prepare('INSERT INTO series (slug, canonical_title, normalized_key) VALUES (?, ?, ?)')
          .run(slug, cleaned, normKey);
        seriesRow = { id: Number(ins.lastInsertRowid) };
      }

      const playlistId = row.playlist_id || `unlocked:${normKey.slice(0, 48)}`;
      const playlistUrl = row.playlist_id
        ? `https://www.youtube.com/playlist?list=${row.playlist_id}`
        : `https://www.youtube.com/watch?v=${row.youtube_video_id}`;

      db.prepare(
        `INSERT INTO channel_series (
          channel_id, series_id, playlist_id, playlist_title, playlist_url,
          thumbnail_url, sub_language, episode_count, access_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'free')
        ON CONFLICT(channel_id, playlist_id) DO UPDATE SET
          episode_count = channel_series.episode_count + 1`
      ).run(
        row.channel_id,
        seriesRow.id,
        playlistId,
        rawSeriesTitle,
        playlistUrl,
        d.thumbnailUrl,
        row.sub_language
      );

      const cs = db
        .prepare('SELECT id FROM channel_series WHERE channel_id = ? AND playlist_id = ?')
        .get(row.channel_id, playlistId) as { id: number };

      db.prepare(
        `INSERT INTO episodes (
          channel_series_id, series_id, channel_id, youtube_video_id,
          title, description, episode_number, playlist_position, sub_language,
          duration_iso, thumbnail_url, published_at, view_count, like_count, comment_count,
          tags, details_synced_at, is_members_only, unlocked_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), 0, unixepoch(), ?)
        ON CONFLICT(channel_series_id, youtube_video_id) DO UPDATE SET
          is_members_only = 0,
          unlocked_at = unixepoch(),
          expires_at = COALESCE(excluded.expires_at, episodes.expires_at)`
      ).run(
        cs.id,
        seriesRow.id,
        row.channel_id,
        row.youtube_video_id,
        d.title,
        d.description ? d.description.slice(0, 2000) : null,
        extractEpisodeNumber(d.title),
        row.sub_language,
        d.durationIso,
        d.thumbnailUrl,
        toUnixSeconds(d.publishedAt),
        d.viewCount,
        d.likeCount,
        d.commentCount,
        JSON.stringify(d.tags.slice(0, 15)),
        extractExpiryDate(d.description)
      );

      refreshSeriesStats(db, seriesRow.id);
      removeLocked.run(row.youtube_video_id);
      unlockedCount++;
    }
  }

  console.log(
    `Live & Unlock Tracker finished: ${liveCount} active LIVE streams | ${unlockedCount} newly unlocked episodes (checked ${lockedRows.length} locked IDs). Quota used: ~${getSessionQuotaUnits()} units.`
  );
  closeDatabase();
  return { liveCount, unlockedCount };
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('live-and-unlocks.ts');
if (isDirect) {
  const limitArg = process.argv.find((a) => a.startsWith('--locked-limit='));
  const lockedCheckLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 500 : 500;
  runLiveAndUnlockTracker({ lockedCheckLimit }).catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
