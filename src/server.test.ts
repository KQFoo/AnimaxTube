import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, refreshSeriesStats } from './db/index.ts';
import { createApp } from './server.ts';

test('Hono API serves channels, grouped series, FTS search, and series detail', async () => {
  closeDatabase();
  const db = openDatabase(':memory:');

  db.prepare(
    `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, is_verified, playlist_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    'UCGbshtvS9t-8CW11W7TooQg',
    '@MuseAsia',
    'Muse Asia',
    'https://www.youtube.com/@MuseAsia',
    '["en"]',
    'anime',
    'SEA',
    1
  );
  db.prepare(
    `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, is_verified, playlist_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    'UC_MUSETW_TEST',
    '@MuseTW',
    'Muse木棉花-TW',
    'https://www.youtube.com/@MuseTW',
    '["zh-Hant"]',
    'anime',
    'TW/HK',
    1
  );

  const ch1 = db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UCGbshtvS9t-8CW11W7TooQg'").get() as { id: number };
  const ch2 = db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UC_MUSETW_TEST'").get() as { id: number };

  const sRes = db
    .prepare(
      `INSERT INTO series (slug, canonical_title, normalized_key, title_en, title_zh)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run('frieren', 'Frieren: Beyond Journey’s End', 'frieren beyond journey s end', 'Frieren: Beyond Journey’s End', '葬送的芙莉蓮');
  const seriesId = Number(sRes.lastInsertRowid);

  const cs1 = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_EN', 'Frieren [Eng Sub]', 'https://www.youtube.com/playlist?list=PL_EN', 'en', 2)`
      )
      .run(ch1.id, seriesId).lastInsertRowid
  );
  const cs2 = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_ZH', '葬送的芙莉蓮 [繁中]', 'https://www.youtube.com/playlist?list=PL_ZH', 'zh-Hant', 1)`
      )
      .run(ch2.id, seriesId).lastInsertRowid
  );

  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, is_members_only, view_count, like_count, comment_count, published_at, duration_iso, tags, region_allowed, details_synced_at)
     VALUES (?, ?, ?, 'vid_en_1', 'Frieren EP01', 1, 0, 'en', 0, 120000, 5000, 400, 1700000000, 'PT24M', '["fantasy","adventure"]', '["MY","SG"]', 1700000000),
            (?, ?, ?, 'vid_en_2', 'Frieren EP02', 2, 1, 'en', 0, 80000, 3000, 200, 1700600000, 'PT24M', '["fantasy","magic"]', '["MY","SG"]', 1700000000),
            (?, ?, ?, 'vid_en_locked', 'Frieren EP03 Members Only', 3, 2, 'en', 1, 0, 0, 0, 1701200000, 'PT24M', '[]', '["MY","SG"]', 1700000000)`
  ).run(cs1, seriesId, ch1.id, cs1, seriesId, ch1.id, cs1, seriesId, ch1.id);
  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, is_members_only, view_count, like_count, comment_count, published_at, duration_iso, tags, region_allowed, details_synced_at)
     VALUES (?, ?, ?, 'vid_zh_1', '葬送的芙莉蓮 第1話', 1, 0, 'zh-Hant', 0, 50000, 2500, 150, 1700100000, 'PT24M', '["奇幻"]', '["TW","HK"]', 1700000000)`
  ).run(cs2, seriesId, ch2.id);

  refreshSeriesStats(db, seriesId);

  db.prepare(
    `UPDATE series
     SET buzz_score = 92.5,
         buzz_tags = '["Masterpiece","Hidden Gem"]',
         top_comment_quote = 'Absolute masterpiece with breathtaking soundtrack and pacing.',
         top_comment_author = '@AnimeFan',
         top_comment_likes = 420,
         unlocked_at = 1702000000,
         expires_at = 1790000000
     WHERE id = ?`
  ).run(seriesId);

  db.prepare(
    `INSERT INTO live_streams (channel_id, youtube_video_id, title, status, concurrent_viewers, checked_at)
     VALUES (?, 'live_vid_1', 'Frieren 24/7 Marathon Live', 'live', 1500, 1702000500)`
  ).run(ch1.id);

  const app = createApp(':memory:');

  const healthRes = await app.request('/api/health');
  assert.equal(healthRes.status, 200);
  const health = (await healthRes.json()) as any;
  assert.equal(health.channels, 2);
  assert.equal(health.series, 1);
  assert.equal(health.episodes, 3);
  assert.equal(health.liveCount, 1);

  const searchRes = await app.request('/api/series?q=葬送&lang=zh');
  assert.equal(searchRes.status, 200);
  const searchJson = (await searchRes.json()) as any;
  assert.equal(searchJson.total, 1);
  assert.equal(searchJson.items[0].channels.length, 2);
  assert.equal(searchJson.items[0].totalViews, 250000);
  assert.ok(searchJson.items[0].tags.includes('fantasy'));

  const tagSortRes = await app.request('/api/series?tag=fantasy&sort=views');
  assert.equal(tagSortRes.status, 200);
  const tagSortJson = (await tagSortRes.json()) as any;
  assert.equal(tagSortJson.total, 1);
  assert.equal(tagSortJson.items[0].slug, 'frieren');

  const tagsRes = await app.request('/api/tags');
  assert.equal(tagsRes.status, 200);
  const tagsJson = (await tagsRes.json()) as any;
  assert.ok(tagsJson.tags.some((t: any) => t.tag === 'fantasy' && t.count === 1));

  const liveRes = await app.request('/api/live');
  assert.equal(liveRes.status, 200);
  const liveJson = (await liveRes.json()) as any;
  assert.equal(liveJson.streams.length, 1);
  assert.equal(liveJson.streams[0].youtube_video_id, 'live_vid_1');

  // Shelves require at least 3 free episodes; the fixture only has 2.
  const shortUnlockedJson = (await (await app.request('/api/unlocked')).json()) as any;
  assert.equal(shortUnlockedJson.items.length, 0);
  const shortRecJson = (await (await app.request('/api/recommendations')).json()) as any;
  assert.equal(shortRecJson.commentPicks.length, 0);

  db.prepare('UPDATE series SET episode_count = 12 WHERE id = ?').run(seriesId);

  const unlockedRes = await app.request('/api/unlocked');
  assert.equal(unlockedRes.status, 200);
  const unlockedJson = (await unlockedRes.json()) as any;
  assert.equal(unlockedJson.items.length, 1);
  assert.equal(unlockedJson.items[0].slug, 'frieren');

  const recRes = await app.request('/api/recommendations');
  assert.equal(recRes.status, 200);
  const recJson = (await recRes.json()) as any;
  assert.equal(recJson.commentPicks.length, 1);
  assert.equal(recJson.hiddenGems.length, 1);
  assert.equal(recJson.commentPicks[0].topCommentAuthor, '@AnimeFan');

  const detailRes = await app.request('/api/series/frieren');
  assert.equal(detailRes.status, 200);
  const detailJson = (await detailRes.json()) as any;
  assert.equal(detailJson.sources.length, 2);
  assert.equal(detailJson.episodes.length, 3);
  assert.ok(detailJson.episodes.every((ep: any) => ep.youtube_video_id !== 'vid_en_locked'));

  // Geo filtering assertions: MY sees Muse Asia (2 eps) and zeroes out Muse木棉花-TW (0 series, 0 episodes)
  const geoChRes = await app.request('/api/channels?region=MY');
  assert.equal(geoChRes.status, 200);
  const geoChJson = (await geoChRes.json()) as any;
  const museAsia = geoChJson.channels.find((c: any) => c.handle === '@MuseAsia');
  const museTw = geoChJson.channels.find((c: any) => c.handle === '@MuseTW');
  assert.equal(museAsia.seriesCount, 1);
  assert.equal(museAsia.totalEpisodes, 2);
  assert.equal(museTw.seriesCount, 0);
  assert.equal(museTw.totalEpisodes, 0);

  const geoSeriesRes = await app.request('/api/series?region=MY');
  const geoSeriesJson = (await geoSeriesRes.json()) as any;
  assert.equal(geoSeriesJson.total, 1);
  assert.equal(geoSeriesJson.items[0].channels.length, 1);
  assert.equal(geoSeriesJson.items[0].channels[0].channelName, 'Muse Asia');

  const geoZhSeriesRes = await app.request('/api/series?region=MY&lang=zh');
  const geoZhSeriesJson = (await geoZhSeriesRes.json()) as any;
  assert.equal(geoZhSeriesJson.total, 0);

  const geoDetailRes = await app.request('/api/series/frieren?region=MY');
  const geoDetailJson = (await geoDetailRes.json()) as any;
  assert.equal(geoDetailJson.sources.length, 1);
  assert.equal(geoDetailJson.episodes.length, 2);

  const blockedDetailRes = await app.request('/api/series/frieren?region=JP');
  const blockedDetailJson = (await blockedDetailRes.json()) as any;
  assert.equal(blockedDetailJson.regionBlocked, true);
  assert.equal(blockedDetailJson.episodes.length, 0);
  assert.equal(blockedDetailJson.lockedSources.length, 2);
  assert.equal(blockedDetailJson.lockedSources[0].channelName, 'Muse Asia');
  assert.equal(blockedDetailJson.lockedSources[0].regionFocus, 'SEA');
  assert.ok(!JSON.stringify(blockedDetailJson.lockedSources).includes('vid_en_1'));

  // Server-rendered SEO for watch pages: neutral directory title naming the licensee
  const watchHtmlRes = await app.request('/watch/frieren');
  assert.equal(watchHtmlRes.status, 200);
  const watchHtml = await watchHtmlRes.text();
  assert.match(
    watchHtml,
    /<title>Frieren: Beyond Journey’s End — Official YouTube Stream Directory \(Muse Asia\) \| AnimaxTube<\/title>/
  );
  assert.match(watchHtml, /<meta property="og:type" content="video\.tv_show" \/>/);
  assert.match(watchHtml, /<link rel="canonical" href="[^"]*\/watch\/frieren" \/>/);
  assert.doesNotMatch(watchHtml, /Free Online/i);

  const missingWatchRes = await app.request('/watch/does-not-exist');
  assert.equal(missingWatchRes.status, 404);
  assert.match(await missingWatchRes.text(), /noindex/);

  for (const legalPath of ['/about', '/legal', '/dmca']) {
    const legalRes = await app.request(legalPath);
    assert.equal(legalRes.status, 200);
    const legalHtml = await legalRes.text();
    assert.match(legalHtml, /<title>About, Legal &amp; DMCA \| AnimaxTube<\/title>/);
  }

  closeDatabase();
});
