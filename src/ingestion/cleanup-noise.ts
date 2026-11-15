import 'dotenv/config';
import { closeDatabase, openDatabase, rebuildAllFts } from '../db/index.ts';
import { cleanSeriesTitle, isNonSeriesPlaylist } from './title-parser.ts';

function main() {
  const db = openDatabase();
  const rows = db
    .prepare('SELECT id, playlist_title, series_id FROM channel_series')
    .all() as unknown as Array<{ id: number; playlist_title: string; series_id: number }>;

  const removeIds: number[] = [];
  for (const r of rows) {
    if (isNonSeriesPlaylist(r.playlist_title)) {
      removeIds.push(r.id);
    }
  }

  db.exec('BEGIN');
  try {
    const delCs = db.prepare('DELETE FROM channel_series WHERE id = ?');
    for (const id of removeIds) {
      delCs.run(id);
    }
    db.exec('DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM channel_series)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Clean any leftover " 動畫" suffix from Muse TW playlists
  const seriesRows = db
    .prepare('SELECT id, canonical_title, title_zh FROM series')
    .all() as unknown as Array<{ id: number; canonical_title: string; title_zh: string | null }>;

  const upd = db.prepare('UPDATE series SET canonical_title = ?, title_zh = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const s of seriesRows) {
      const cleaned = cleanSeriesTitle(s.canonical_title).replace(/\s+動畫$/, '').trim();
      const cleanedZh = s.title_zh ? s.title_zh.replace(/\s+動畫$/, '').trim() : null;
      if (cleaned && (cleaned !== s.canonical_title || cleanedZh !== s.title_zh)) {
        upd.run(cleaned, cleanedZh, s.id);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  rebuildAllFts(db);

  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM channels WHERE is_verified = 1) AS ch,
              (SELECT COUNT(*) FROM series) AS sr,
              (SELECT COUNT(*) FROM channel_series) AS cs,
              (SELECT COUNT(*) FROM episodes) AS ep`
    )
    .get() as { ch: number; sr: number; cs: number; ep: number };

  console.log(
    `Removed ${removeIds.length} clip/marathon/OPED/announcement playlists. Remaining: ${stats.ch} channels | ${stats.sr} grouped series | ${stats.cs} playlists | ${stats.ep} episodes.`
  );
  closeDatabase();
}

main();
