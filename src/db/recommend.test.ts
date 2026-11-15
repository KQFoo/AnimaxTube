import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, type SeriesListItem } from './index.ts';
import { diversifyShelf, queryForYou, queryTrending, trendScore } from './recommend.ts';
import type { DatabaseSync } from 'node:sqlite';

function seedCatalog(db: DatabaseSync) {
  db.prepare(
    `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, is_verified, playlist_count)
     VALUES ('UC_A', '@a', 'Chan A', 'https://youtube.com/@a', '["en"]', 'anime', 'SEA', 1, 1),
            ('UC_B', '@b', 'Chan B', 'https://youtube.com/@b', '["en"]', 'anime', 'SEA', 1, 1)`
  ).run();
  const chA = (db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UC_A'").get() as { id: number }).id;
  const chB = (db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UC_B'").get() as { id: number }).id;

  const add = (slug: string, channelId: number, genres: string[], tags: string[], opts: { eps?: number; views?: number } = {}) => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO series (slug, canonical_title, normalized_key, genres, tags, sub_languages, episode_count, total_views, buzz_score)
           VALUES (?, ?, ?, ?, ?, '["en"]', ?, ?, 50)`
        )
        .run(slug, slug, slug, JSON.stringify(genres), JSON.stringify(tags), opts.eps ?? 12, opts.views ?? 100000).lastInsertRowid
    );
    const cs = Number(
      db
        .prepare(
          `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
           VALUES (?, ?, ?, ?, '', 'en', 12)`
        )
        .run(channelId, id, `PL_${slug}`, slug).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position)
       VALUES (?, ?, ?, ?, ?, 1, 0)`
    ).run(cs, id, channelId, `vid_${slug}`, `${slug} EP1`);
  };

  add('frieren', chA, ['Fantasy', 'Adventure', 'Drama'], ['fantasy', 'magic']);
  add('mushoku', chB, ['Fantasy', 'Adventure', 'Drama'], ['fantasy', 'isekai']);
  add('dungeon-meshi', chA, ['Fantasy', 'Adventure', 'Comedy'], ['fantasy', 'food']);
  add('kaguya', chB, ['Romance', 'Comedy'], ['school', 'romcom']);
  add('fantasy-oneshot', chA, ['Fantasy', 'Adventure', 'Drama'], ['fantasy', 'magic'], { eps: 1 });
  add('watched-fantasy', chA, ['Fantasy', 'Adventure', 'Drama'], ['fantasy', 'magic']);
}

test('queryForYou ranks similar series, excludes seeds/excluded/ineligible, and skips unrelated ones', () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  seedCatalog(db);

  const rows = queryForYou(db, { seeds: ['frieren'], exclude: ['watched-fantasy'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seed.slug, 'frieren');
  const slugs = rows[0].items.map((i) => i.slug);
  assert.equal(slugs[0], 'mushoku');
  assert.ok(slugs.includes('dungeon-meshi'));
  assert.ok(!slugs.includes('frieren'));
  assert.ok(!slugs.includes('watched-fantasy'));
  assert.ok(!slugs.includes('fantasy-oneshot'), 'shelf eligibility requires 3+ episodes');
  assert.ok(!slugs.includes('kaguya'), 'no shared genre/tag means no recommendation');

  assert.deepEqual(queryForYou(db, { seeds: [] }), []);
  assert.deepEqual(queryForYou(db, { seeds: ['missing-slug'] }), []);
  closeDatabase();
});

test('trendScore favors relative growth over sheer size', () => {
  // 50K new views on a 200K show beats 60K new views on a 50M show.
  assert.ok(trendScore(50_000, 200_000) > trendScore(60_000, 50_000_000));
  assert.ok(trendScore(0, 1000) < 0);
});

test('queryTrending ranks by weekly view velocity and needs a baseline', () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  seedCatalog(db);
  const now = 1_800_000_000;
  const day = 86400;
  const idOf = (slug: string) => (db.prepare('SELECT id FROM series WHERE slug = ?').get(slug) as { id: number }).id;
  const snap = db.prepare('INSERT INTO series_view_snapshots (series_id, captured_at, total_views) VALUES (?, ?, ?)');

  // mushoku: 100K now, was 40K 8 days ago -> fast riser.
  db.prepare("UPDATE series SET total_views = 100000 WHERE slug = 'mushoku'").run();
  snap.run(idOf('mushoku'), now - 8 * day, 40_000);
  // frieren: 100K now, was 95K 7 days ago -> slow.
  snap.run(idOf('frieren'), now - 7 * day, 95_000);
  // kaguya: only 3 days of history, +30K -> scaled to 70K/week.
  db.prepare("UPDATE series SET total_views = 130000 WHERE slug = 'kaguya'").run();
  snap.run(idOf('kaguya'), now - 3 * day, 100_000);
  // dungeon-meshi: snapshot from today only -> no baseline, excluded.
  snap.run(idOf('dungeon-meshi'), now, 100_000);
  // fantasy-oneshot: big growth but ineligible (1 episode).
  snap.run(idOf('fantasy-oneshot'), now - 8 * day, 1_000);

  const slugs = queryTrending(db, 16, null, now).map((i) => i.slug);
  assert.deepEqual(slugs, ['kaguya', 'mushoku', 'frieren']);
  closeDatabase();
});

test('queryForYou assigns each candidate to only one seed row', () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  seedCatalog(db);

  const rows = queryForYou(db, { seeds: ['frieren', 'mushoku'] });
  const all = rows.flatMap((r) => r.items.map((i) => i.slug));
  assert.equal(all.length, new Set(all).size);
  closeDatabase();
});

function item(slug: string, channelId: number, tags: string[] = []): SeriesListItem {
  return {
    id: slug.length * 1000 + channelId,
    slug,
    canonicalTitle: slug,
    titleEn: null,
    titleZh: null,
    titleRomaji: null,
    anilistId: null,
    posterUrl: null,
    episodeCount: 12,
    totalViews: 0,
    totalLikes: 0,
    totalComments: 0,
    latestUploadedAt: null,
    firstDurationIso: null,
    tags,
    subLanguages: ['en'],
    buzzScore: 0,
    buzzTags: [],
    topCommentQuote: null,
    topCommentAuthor: null,
    unlockedAt: null,
    expiresAt: null,
    updatedAt: 0,
    channels: [
      {
        channelId,
        channelName: `ch${channelId}`,
        channelAvatar: null,
        handle: null,
        subLanguage: 'en',
        playlistId: 'PL',
        playlistTitle: slug,
        playlistUrl: '',
        episodeCount: 12,
      },
    ],
  };
}

test('diversifyShelf caps items per channel before backfilling', () => {
  const ranked = [item('a1', 1), item('a2', 1), item('a3', 1), item('a4', 1), item('b1', 2), item('c1', 3)];
  const out = diversifyShelf(ranked, { limit: 4 }).map((i) => i.slug);
  assert.deepEqual(out, ['a1', 'a2', 'b1', 'c1']);

  const short = diversifyShelf(ranked, { limit: 6 }).map((i) => i.slug);
  assert.equal(short.length, 6);
  assert.deepEqual(short.slice(0, 4), ['a1', 'a2', 'b1', 'c1']);
});

test('diversifyShelf demotes near-duplicate tag profiles', () => {
  const tags = ['isekai', 'fantasy', 'action', 'comedy'];
  const ranked = [item('x1', 1, tags), item('x2', 2, tags), item('y1', 3, ['romance', 'school']), item('z1', 4, ['mecha'])];
  const out = diversifyShelf(ranked, { limit: 4 }).map((i) => i.slug);
  assert.equal(out[0], 'x1');
  assert.notEqual(out[1], 'x2');
  assert.ok(out.includes('x2'));
});
