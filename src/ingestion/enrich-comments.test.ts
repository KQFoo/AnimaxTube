import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase } from '../db/index.ts';
import { RESCORE_AFTER_SECONDS, selectCommentCandidates } from './enrich-comments.ts';

test('selectCommentCandidates mixes top, stratified small, and recent series and skips fresh scores', () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  const now = 1_800_000_000;

  db.prepare(
    `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, is_verified, playlist_count)
     VALUES ('UC_TEST', '@t', 'Test', 'https://youtube.com/@t', '["en"]', 'anime', 'SEA', 1, 1)`
  ).run();
  const channelId = (db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UC_TEST'").get() as { id: number }).id;

  const addSeries = (slug: string, views: number, opts: { eps?: number; scoredAt?: number; uploadedAt?: number } = {}) => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO series (slug, canonical_title, normalized_key, episode_count, total_views, buzz_scored_at, latest_uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(slug, slug, slug, opts.eps ?? 12, views, opts.scoredAt ?? null, opts.uploadedAt ?? now - 400 * 86400)
        .lastInsertRowid
    );
    const cs = Number(
      db
        .prepare(
          `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
           VALUES (?, ?, ?, ?, ?, 'en', 12)`
        )
        .run(channelId, id, `PL_${slug}`, slug, `https://youtube.com/playlist?list=PL_${slug}`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, view_count, like_count, comment_count)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, 10, 1)`
    ).run(cs, id, channelId, `vid_${slug}`, `${slug} EP1`, Math.max(1, Math.floor(views / 10)));
  };

  for (let i = 0; i < 6; i++) addSeries(`big${i}`, 5_000_000 + i * 1_000_000);
  addSeries('band1', 5_000);
  addSeries('band2', 30_000);
  addSeries('band3', 100_000);
  addSeries('band4', 300_000);
  addSeries('tiny-oneshot', 20_000, { eps: 1 });
  addSeries('recent', 2_000_000, { uploadedAt: now - 2 * 86400 });
  addSeries('fresh-score', 9_000_000, { scoredAt: now - 86400 });
  addSeries('stale-score', 8_500_000, { scoredAt: now - RESCORE_AFTER_SECONDS - 86400 });

  const picked = selectCommentCandidates(db, 10, now).map((c) => c.ep1_video_id.replace('vid_', ''));

  assert.equal(picked.length, 10);
  assert.ok(!picked.includes('fresh-score'), 'recently scored series must be skipped');
  assert.ok(picked.includes('stale-score'), 'stale scores are eligible for rescoring');
  for (const band of ['band1', 'band2', 'band3', 'band4']) {
    assert.ok(picked.includes(band), `${band} should be sampled into the hidden-gem pool`);
  }
  assert.ok(picked.includes('recent'), 'recent uploads get a dedicated quota');

  closeDatabase();
});
