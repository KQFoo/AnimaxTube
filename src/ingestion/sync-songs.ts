import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, openDatabase } from '../db/index.ts';
import type { ChannelRow } from '../db/schema.ts';
import { upsertChannel } from '../discovery/add-channel.ts';
import {
  fetchAllPlaylists,
  fetchChannelByHandle,
  fetchPlaylistItems,
  fetchVideoDetailsMap,
  getSessionQuotaUnits,
} from '../lib/youtube.ts';
import {
  classifyAnimeSong,
  cleanSeriesTitle,
  isMembersOnlyText,
  isMusicPlaylist,
  normalizeSeriesKey,
} from './title-parser.ts';

export interface MusicChannelSeed {
  name: string;
  handle: string;
  regionFocus: string;
  subLanguages: Array<'en' | 'zh-Hant' | 'zh-Hans'>;
}

/**
 * Curated official anime studios & music labels that publish official
 * creditless OP/EDs, theme songs, and OSTs on YouTube.
 */
export const ANIME_MUSIC_CHANNELS: MusicChannelSeed[] = [
  { name: 'Aniplex', handle: '@aniplex', regionFocus: 'Global / Japan', subLanguages: ['en'] },
  { name: 'Aniplex USA', handle: '@AniplexUSA', regionFocus: 'North America / Global', subLanguages: ['en'] },
  { name: 'TOHO animation', handle: '@TOHOanimation', regionFocus: 'Global / Japan', subLanguages: ['en'] },
  { name: 'KADOKAWAanime', handle: '@KADOKAWAanime', regionFocus: 'Global / Japan', subLanguages: ['en'] },
  { name: 'Lantis', handle: '@Lantis', regionFocus: 'Global / Japan', subLanguages: ['en'] },
  { name: 'KING AMUSEMENT CREATIVE', handle: '@king-cr', regionFocus: 'Global / Japan', subLanguages: ['en'] },
  { name: 'PONY CANYON', handle: '@ponycanyon', regionFocus: 'Global / Japan', subLanguages: ['en'] },
];

function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function findMatchingSeriesId(db: DatabaseSync, rawTitle: string | null): number | null {
  if (!rawTitle) return null;
  const key = normalizeSeriesKey(rawTitle);
  if (!key || key.length < 2) return null;
  const row = db
    .prepare('SELECT id FROM series WHERE normalized_key = ? LIMIT 1')
    .get(key) as { id: number } | undefined;
  return row ? row.id : null;
}

export async function ensureMusicChannels(db: DatabaseSync): Promise<number> {
  const existing = db
    .prepare('SELECT handle FROM channels WHERE handle IS NOT NULL')
    .all() as unknown as Array<{ handle: string }>;
  const knownHandles = new Set(existing.map((r) => r.handle.trim().toLowerCase()));

  let added = 0;
  for (const seed of ANIME_MUSIC_CHANNELS) {
    if (knownHandles.has(seed.handle.toLowerCase())) continue;
    try {
      const info = await fetchChannelByHandle(seed.handle);
      if (!info) continue;
      upsertChannel(db, {
        info,
        handle: seed.handle,
        category: 'studio',
        regionFocus: seed.regionFocus,
        subLanguages: seed.subLanguages,
        discoverySource: 'music_registry',
        isVerified: true,
        playlistCount: 0,
        syncPlaylists: false,
        syncVideos: false,
      });
      knownHandles.add(seed.handle.toLowerCase());
      added++;
      console.log(`  [music-channel] Added ${info.title} (${seed.handle})`);
    } catch (err) {
      console.warn(`  [warn] Could not resolve ${seed.handle}:`, err instanceof Error ? err.message : err);
    }
  }
  return added;
}

export async function syncChannelSongs(
  db: DatabaseSync,
  channel: ChannelRow,
  opts: { skipVideoDetails?: boolean; maxPlaylistPages?: number; maxUploadPages?: number } = {}
): Promise<number> {
  const maxPlaylistPages = opts.maxPlaylistPages ?? 5;
  const maxUploadPages = opts.maxUploadPages ?? 2;

  const existingSongIds = new Set(
    (
      db
        .prepare('SELECT youtube_video_id FROM songs WHERE channel_id = ?')
        .all(channel.id) as unknown as Array<{ youtube_video_id: string }>
    ).map((r) => r.youtube_video_id)
  );

  const upsertSong = db.prepare(
    `INSERT INTO songs (
      channel_id, series_id, youtube_video_id, playlist_id, playlist_title, title,
      song_type, anime_title, thumbnail_url, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(youtube_video_id) DO UPDATE SET
      series_id = COALESCE(excluded.series_id, songs.series_id),
      playlist_id = COALESCE(excluded.playlist_id, songs.playlist_id),
      playlist_title = COALESCE(excluded.playlist_title, songs.playlist_title),
      title = excluded.title,
      song_type = excluded.song_type,
      anime_title = COALESCE(excluded.anime_title, songs.anime_title),
      thumbnail_url = COALESCE(excluded.thumbnail_url, songs.thumbnail_url),
      published_at = COALESCE(excluded.published_at, songs.published_at)`
  );

  const newVideoIds: string[] = [];
  let touched = 0;

  // 1. Scan official music / OP / ED / OST playlists
  const playlists = await fetchAllPlaylists(channel.youtube_channel_id, maxPlaylistPages);
  const musicPlaylists = playlists.filter((pl) => pl.itemCount > 0 && isMusicPlaylist(pl.title));

  for (const pl of musicPlaylists) {
    const items = await fetchPlaylistItems(pl.id, 3);
    db.exec('BEGIN');
    try {
      for (const it of items) {
        if (isMembersOnlyText(`${it.title} ${it.description}`)) continue;
        const songType = classifyAnimeSong(it.title, pl.title);
        if (!songType) continue;
        const animeTitle = cleanSeriesTitle(it.title) || cleanSeriesTitle(pl.title) || null;
        const seriesId = findMatchingSeriesId(db, animeTitle);
        upsertSong.run(
          channel.id,
          seriesId,
          it.videoId,
          pl.id,
          pl.title,
          it.title,
          songType,
          animeTitle,
          it.thumbnailUrl,
          toUnixSeconds(it.publishedAt)
        );
        if (!existingSongIds.has(it.videoId)) {
          existingSongIds.add(it.videoId);
          newVideoIds.push(it.videoId);
        }
        touched++;
      }
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
    }
  }

  // 2. Scan recent uploads for OP/ED/OST videos
  const uploadsPlaylistId =
    channel.uploads_playlist_id ||
    (channel.youtube_channel_id.startsWith('UC') ? `UU${channel.youtube_channel_id.slice(2)}` : null);
  if (uploadsPlaylistId) {
    const uploads = await fetchPlaylistItems(uploadsPlaylistId, maxUploadPages);
    db.exec('BEGIN');
    try {
      for (const it of uploads) {
        if (isMembersOnlyText(`${it.title} ${it.description}`)) continue;
        const songType = classifyAnimeSong(it.title);
        if (!songType) continue;
        const animeTitle = cleanSeriesTitle(it.title) || null;
        const seriesId = findMatchingSeriesId(db, animeTitle);
        upsertSong.run(
          channel.id,
          seriesId,
          it.videoId,
          null,
          null,
          it.title,
          songType,
          animeTitle,
          it.thumbnailUrl,
          toUnixSeconds(it.publishedAt)
        );
        if (!existingSongIds.has(it.videoId)) {
          existingSongIds.add(it.videoId);
          newVideoIds.push(it.videoId);
        }
        touched++;
      }
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
    }
  }

  // 3. Enrich new songs with duration, views, likes, geo-restrictions, and embeddability
  if (newVideoIds.length > 0 && !opts.skipVideoDetails) {
    const detailsMap = await fetchVideoDetailsMap(newVideoIds);
    const updateSong = db.prepare(
      `UPDATE songs
       SET duration_iso = ?,
           view_count = ?,
           like_count = ?,
           published_at = COALESCE(?, published_at),
           region_allowed = ?,
           region_blocked = ?
       WHERE channel_id = ? AND youtube_video_id = ?`
    );
    const deleteSong = db.prepare('DELETE FROM songs WHERE channel_id = ? AND youtube_video_id = ?');

    db.exec('BEGIN');
    try {
      for (const [vid, d] of detailsMap) {
        if (!d.embeddable || d.isMembersOnly || isMembersOnlyText(`${d.title} ${d.description}`)) {
          deleteSong.run(channel.id, vid);
          continue;
        }
        updateSong.run(
          d.durationIso,
          d.viewCount,
          d.likeCount,
          toUnixSeconds(d.publishedAt),
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

  return touched;
}

export async function runSongSync() {
  const db = openDatabase();
  const skipMusicSeeds = process.argv.includes('--skip-music-seeds');
  const skipVideoDetails = process.argv.includes('--skip-video-details');

  if (!skipMusicSeeds) {
    console.log('Checking curated official anime studio & music channels...');
    await ensureMusicChannels(db);
  }

  const channels = db
    .prepare('SELECT * FROM channels WHERE is_verified = 1 ORDER BY CASE WHEN discovery_source = \'music_registry\' THEN 0 ELSE 1 END, id ASC')
    .all() as unknown as ChannelRow[];

  console.log(`Scanning ${channels.length} verified channel(s) for anime OP, ED, and OST songs...`);
  let totalTouched = 0;
  for (const ch of channels) {
    try {
      const count = await syncChannelSongs(db, ch, { skipVideoDetails });
      if (count > 0) {
        console.log(`  -> ${ch.name}: ${count} song(s) indexed/updated`);
        totalTouched += count;
      }
    } catch (err) {
      console.error(`  [error] Song sync failed for ${ch.name}:`, err instanceof Error ? err.message : err);
    }
  }

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN song_type = 'op' THEN 1 ELSE 0 END) AS op_cnt,
              SUM(CASE WHEN song_type = 'ed' THEN 1 ELSE 0 END) AS ed_cnt,
              SUM(CASE WHEN song_type = 'ost' THEN 1 ELSE 0 END) AS ost_cnt
       FROM songs`
    )
    .get() as { total: number; op_cnt: number | null; ed_cnt: number | null; ost_cnt: number | null };

  console.log(
    `\nSong sync complete: ${stats.total} total songs (${stats.op_cnt || 0} OP, ${stats.ed_cnt || 0} ED, ${stats.ost_cnt || 0} OST; ${totalTouched} touched this run). Quota used: ~${getSessionQuotaUnits()} units.`
  );
  closeDatabase();
}

const isDirect =
  Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  runSongSync().catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
