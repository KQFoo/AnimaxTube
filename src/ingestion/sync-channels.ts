import 'dotenv/config';
import {
  ensureUniqueSlug,
  openDatabase,
  closeDatabase,
  parseJsonArray,
  refreshSeriesStats,
} from '../db/index.ts';
import type { ChannelRow, SeriesRow } from '../db/schema.ts';
import {
  fetchAllPlaylists,
  fetchPlaylistItems,
  fetchVideoDetailsMap,
  getSessionQuotaUnits,
} from '../lib/youtube.ts';
import {
  cleanSeriesTitle,
  detectChineseScript,
  detectSubLanguage,
  extractEpisodeNumber,
  extractExpiryDate,
  isMembersOnlyPlaylist,
  isMembersOnlyText,
  isNonSeriesPlaylist,
  isPromoVideo,
  normalizeSeriesKey,
  type SubLanguage,
} from './title-parser.ts';

function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function getOrCreateSeries(
  db: ReturnType<typeof openDatabase>,
  rawTitle: string,
  subLang: SubLanguage
): number {
  const cleaned = cleanSeriesTitle(rawTitle);
  const key = normalizeSeriesKey(cleaned);

  const existing = db
    .prepare('SELECT id, title_en, title_zh FROM series WHERE normalized_key = ? LIMIT 1')
    .get(key) as unknown as Pick<SeriesRow, 'id' | 'title_en' | 'title_zh'> | undefined;

  if (existing) {
    if (subLang === 'en' && !existing.title_en) {
      db.prepare('UPDATE series SET title_en = ? WHERE id = ?').run(cleaned, existing.id);
    } else if (subLang.startsWith('zh') && !existing.title_zh) {
      db.prepare('UPDATE series SET title_zh = ? WHERE id = ?').run(cleaned, existing.id);
    }
    return existing.id;
  }

  const slug = ensureUniqueSlug(db, cleaned);
  const titleEn = subLang === 'en' || !detectChineseScript(cleaned) ? cleaned : null;
  const titleZh = subLang.startsWith('zh') || detectChineseScript(cleaned) ? cleaned : null;

  const res = db
    .prepare(
      `INSERT INTO series (slug, canonical_title, normalized_key, title_en, title_zh)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(slug, cleaned, key, titleEn, titleZh);

  return Number(res.lastInsertRowid);
}

export async function syncChannel(db: ReturnType<typeof openDatabase>, channel: ChannelRow) {
  const channelLangs = parseJsonArray(channel.sub_languages);
  const defaultLang = (channelLangs[0] as SubLanguage) || 'en';
  const playlists = await fetchAllPlaylists(channel.youtube_channel_id, 25);

  console.log(`\nSyncing ${channel.name} (${playlists.length} total playlists)...`);
  const seenVideoIds = new Set<string>();
  const newVideoIdsForDetails: string[] = [];
  const touchedSeriesIds = new Set<number>();
  let syncedPlaylists = 0;

  const recordLocked = db.prepare(
    `INSERT INTO locked_watch_pool (youtube_video_id, channel_id, playlist_id, playlist_title, title, sub_language, detected_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(youtube_video_id) DO UPDATE SET
       playlist_id = COALESCE(excluded.playlist_id, locked_watch_pool.playlist_id),
       playlist_title = COALESCE(excluded.playlist_title, locked_watch_pool.playlist_title),
       title = excluded.title`
  );

  for (const pl of playlists) {
    if (pl.itemCount <= 0 || isNonSeriesPlaylist(pl.title) || isMembersOnlyPlaylist(pl.title)) {
      // If explicitly a members-only/ULTRA playlist, record items in locked_watch_pool for unlock tracking
      if (pl.itemCount > 0 && isMembersOnlyPlaylist(pl.title) && !process.argv.includes('--skip-locked-pool')) {
        const lockedItems = await fetchPlaylistItems(pl.id, 3);
        const plLang = detectSubLanguage(pl.title, defaultLang);
        if (plLang !== 'other') {
          db.exec('BEGIN');
          try {
            for (const it of lockedItems) {
              if (!isPromoVideo(it.title)) {
                recordLocked.run(it.videoId, channel.id, pl.id, pl.title, it.title, plLang, 'playlist_title');
              }
            }
            db.exec('COMMIT');
          } catch {
            db.exec('ROLLBACK');
          }
        }
      }
      continue;
    }

    const items = await fetchPlaylistItems(pl.id, 10);
    const validFreeItems = items.filter((item) => {
      if (isPromoVideo(item.title)) return false;
      if (isMembersOnlyText(`${item.title} ${item.description}`)) {
        recordLocked.run(
          item.videoId,
          channel.id,
          pl.id,
          pl.title,
          item.title,
          detectSubLanguage(item.title, defaultLang),
          'item_text'
        );
        return false;
      }
      return true;
    });

    if (validFreeItems.length === 0) continue;

    const sampleTitle = `${pl.title} ${validFreeItems[0]?.title || ''}`;
    const detectedLang = detectSubLanguage(sampleTitle, defaultLang);
    if (detectedLang === 'other') continue;

    const seriesId = getOrCreateSeries(db, pl.title, detectedLang);
    touchedSeriesIds.add(seriesId);

    const playlistUrl = `https://www.youtube.com/playlist?list=${pl.id}`;
    const thumb = pl.thumbnailUrl || validFreeItems[0]?.thumbnailUrl || null;

    db.prepare(
      `INSERT INTO channel_series (
        channel_id, series_id, playlist_id, playlist_title, playlist_url,
        thumbnail_url, sub_language, episode_count, access_note, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'free', ?)
      ON CONFLICT(channel_id, playlist_id) DO UPDATE SET
        series_id = excluded.series_id,
        playlist_title = excluded.playlist_title,
        playlist_url = excluded.playlist_url,
        thumbnail_url = COALESCE(excluded.thumbnail_url, channel_series.thumbnail_url),
        sub_language = excluded.sub_language,
        episode_count = excluded.episode_count,
        access_note = 'free'`
    ).run(
      channel.id,
      seriesId,
      pl.id,
      pl.title,
      playlistUrl,
      thumb,
      detectedLang,
      validFreeItems.length,
      toUnixSeconds(pl.publishedAt)
    );

    const csRow = db
      .prepare('SELECT id FROM channel_series WHERE channel_id = ? AND playlist_id = ?')
      .get(channel.id, pl.id) as { id: number };

    const existingEps = db
      .prepare('SELECT youtube_video_id FROM episodes WHERE channel_series_id = ?')
      .all(csRow.id) as unknown as Array<{ youtube_video_id: string }>;
    const existingSet = new Set(existingEps.map((e) => e.youtube_video_id));

    const insertEp = db.prepare(
      `INSERT INTO episodes (
        channel_series_id, series_id, channel_id, youtube_video_id,
        title, description, episode_number, playlist_position, sub_language,
        thumbnail_url, published_at, expires_at, is_members_only
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(channel_series_id, youtube_video_id) DO UPDATE SET
        title = excluded.title,
        description = COALESCE(excluded.description, episodes.description),
        episode_number = COALESCE(excluded.episode_number, episodes.episode_number),
        playlist_position = excluded.playlist_position,
        sub_language = excluded.sub_language,
        thumbnail_url = COALESCE(excluded.thumbnail_url, episodes.thumbnail_url),
        expires_at = COALESCE(excluded.expires_at, episodes.expires_at),
        is_members_only = 0`
    );

    db.exec('BEGIN');
    try {
      for (const item of validFreeItems) {
        seenVideoIds.add(item.videoId);
        if (!existingSet.has(item.videoId)) {
          newVideoIdsForDetails.push(item.videoId);
        }
        const epNum = extractEpisodeNumber(item.title);
        const epLang = detectSubLanguage(item.title, detectedLang);
        const expiresAt = extractExpiryDate(item.description);

        insertEp.run(
          csRow.id,
          seriesId,
          channel.id,
          item.videoId,
          item.title,
          item.description ? item.description.slice(0, 2000) : null,
          epNum,
          item.position,
          epLang === 'other' ? detectedLang : epLang,
          item.thumbnailUrl,
          toUnixSeconds(item.publishedAt),
          expiresAt
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    syncedPlaylists++;
  }

  // Fallback: scan recent uploads for standalone full-episode uploads not in any playlist
  if (channel.uploads_playlist_id) {
    const uploads = await fetchPlaylistItems(channel.uploads_playlist_id, 4);
    const unplaylistedByKey = new Map<
      string,
      { displayTitle: string; lang: SubLanguage; items: typeof uploads }
    >();

    for (const item of uploads) {
      if (seenVideoIds.has(item.videoId) || isPromoVideo(item.title)) continue;
      if (isMembersOnlyText(`${item.title} ${item.description}`)) continue;
      const epNum = extractEpisodeNumber(item.title);
      if (epNum === null) continue;
      const lang = detectSubLanguage(item.title, defaultLang);
      if (lang === 'other') continue;

      const cleaned = cleanSeriesTitle(item.title);
      if (!cleaned || cleaned.length < 2) continue;
      const key = normalizeSeriesKey(cleaned);
      const bucket = unplaylistedByKey.get(key) || { displayTitle: cleaned, lang, items: [] };
      bucket.items.push(item);
      unplaylistedByKey.set(key, bucket);
    }

    for (const [key, group] of unplaylistedByKey) {
      if (group.items.length < 2) continue;
      const virtualPlaylistId = `uploads:${key.slice(0, 64)}`;
      const seriesId = getOrCreateSeries(db, group.displayTitle, group.lang);
      touchedSeriesIds.add(seriesId);

      db.prepare(
        `INSERT INTO channel_series (
          channel_id, series_id, playlist_id, playlist_title, playlist_url,
          thumbnail_url, sub_language, episode_count, access_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'free')
        ON CONFLICT(channel_id, playlist_id) DO UPDATE SET
          series_id = excluded.series_id,
          episode_count = excluded.episode_count`
      ).run(
        channel.id,
        seriesId,
        virtualPlaylistId,
        `${group.displayTitle} (Uploads)`,
        channel.url,
        group.items[0]?.thumbnailUrl || null,
        group.lang,
        group.items.length
      );

      const csRow = db
        .prepare('SELECT id FROM channel_series WHERE channel_id = ? AND playlist_id = ?')
        .get(channel.id, virtualPlaylistId) as { id: number };

      for (const item of group.items) {
        newVideoIdsForDetails.push(item.videoId);
        const epNum = extractEpisodeNumber(item.title);
        db.prepare(
          `INSERT INTO episodes (
            channel_series_id, series_id, channel_id, youtube_video_id,
            title, description, episode_number, playlist_position, sub_language,
            thumbnail_url, published_at, expires_at, is_members_only
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT(channel_series_id, youtube_video_id) DO NOTHING`
        ).run(
          csRow.id,
          seriesId,
          channel.id,
          item.videoId,
          item.title,
          item.description ? item.description.slice(0, 2000) : null,
          epNum,
          item.position,
          group.lang,
          item.thumbnailUrl,
          toUnixSeconds(item.publishedAt),
          extractExpiryDate(item.description)
        );
      }
      syncedPlaylists++;
    }
  }

  // Enrich new videos with views, likes, comments, upload date, tags, duration, & API members-only verification
  if (newVideoIdsForDetails.length > 0 && !process.argv.includes('--skip-video-details')) {
    const detailsMap = await fetchVideoDetailsMap(newVideoIdsForDetails.slice(0, 1500));
    const updateEp = db.prepare(
      `UPDATE episodes
       SET duration_iso = ?,
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
       WHERE channel_id = ? AND youtube_video_id = ?`
    );
    const deleteLockedEp = db.prepare('DELETE FROM episodes WHERE channel_id = ? AND youtube_video_id = ?');

    db.exec('BEGIN');
    try {
      for (const [vid, d] of detailsMap) {
        if (d.isMembersOnly || isMembersOnlyText(`${d.title} ${d.description}`)) {
          recordLocked.run(vid, channel.id, null, null, d.title, defaultLang, 'api_viewcount_missing');
          deleteLockedEp.run(channel.id, vid);
          continue;
        }
        updateEp.run(
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
          channel.id,
          vid
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  for (const sid of touchedSeriesIds) {
    refreshSeriesStats(db, sid);
  }

  db.prepare('UPDATE channels SET playlist_count = ?, last_synced_at = unixepoch() WHERE id = ?').run(
    playlists.length,
    channel.id
  );
  console.log(`  -> Synced ${syncedPlaylists} free anime series playlists (${seenVideoIds.size} videos).`);
}

export async function runSync() {
  const db = openDatabase();
  const channelFilterArg = process.argv.find((a) => a.startsWith('--channel='));
  const channelFilter = channelFilterArg ? channelFilterArg.split('=')[1] : null;

  const channels = (
    channelFilter
      ? db
          .prepare('SELECT * FROM channels WHERE is_verified = 1 AND (youtube_channel_id = ? OR name LIKE ?)')
          .all(channelFilter, `%${channelFilter}%`)
      : db.prepare('SELECT * FROM channels WHERE is_verified = 1 ORDER BY id ASC').all()
  ) as unknown as ChannelRow[];

  if (channels.length === 0) {
    console.log('No verified channels found in DB. Run `npm run discover` first.');
    closeDatabase();
    return;
  }

  for (const ch of channels) {
    try {
      await syncChannel(db, ch);
    } catch (err) {
      console.error(`  [error] Failed syncing ${ch.name}:`, err instanceof Error ? err.message : err);
    }
  }

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM channels WHERE is_verified = 1) AS ch_cnt,
              (SELECT COUNT(*) FROM series WHERE episode_count > 0) AS sr_cnt,
              (SELECT COUNT(*) FROM episodes WHERE is_members_only = 0) AS ep_cnt`
    )
    .get() as { ch_cnt: number; sr_cnt: number; ep_cnt: number };

  console.log(
    `\nSync complete: ${stats.ch_cnt} channels | ${stats.sr_cnt} grouped series | ${stats.ep_cnt} free episodes. Quota used: ~${getSessionQuotaUnits()} units.`
  );
  closeDatabase();
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('sync-channels.ts');
if (isDirect) {
  runSync().catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
