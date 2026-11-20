import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, refreshSeriesStats } from './db/index.ts';
import { queryCalendar } from './db/calendar.ts';
import { createApp } from './server.ts';

const DAY = 86400;
const WEEK = 7 * DAY;

test('queryCalendar returns released episodes, exact premieres, and weekly YT cadence predictions with geo filtering', async () => {
  closeDatabase();
  const db = openDatabase(':memory:');

  // Base timestamp: 2026-11-21 12:00:00 UTC
  const nowSec = 1795262400;
  const weekStart = nowSec - 3 * DAY;
  const weekEnd = weekStart + WEEK;

  db.prepare(
    `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, is_verified, playlist_count)
     VALUES ('UC_MUSE_ASIA', '@MuseAsia', 'Muse Asia', 'https://www.youtube.com/@MuseAsia', '["en"]', 'anime', 'SEA', 1, 2),
            ('UC_MUSE_TW', '@MuseTW', 'Muse木棉花-TW', 'https://www.youtube.com/@MuseTW', '["zh-Hant"]', 'anime', 'TW/HK', 1, 1)`
  ).run();

  const chEn = db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UC_MUSE_ASIA'").get() as { id: number };
  const chZh = db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UC_MUSE_TW'").get() as { id: number };

  const s1Id = Number(
    db
      .prepare("INSERT INTO series (slug, canonical_title, normalized_key) VALUES ('weekly-show', 'Weekly Simulcast', 'weekly simulcast')")
      .run().lastInsertRowid
  );
  const s2Id = Number(
    db
      .prepare("INSERT INTO series (slug, canonical_title, normalized_key) VALUES ('stale-show', 'Completed Classic', 'completed classic')")
      .run().lastInsertRowid
  );
  const s3Id = Number(
    db
      .prepare("INSERT INTO series (slug, canonical_title, normalized_key) VALUES ('tw-only-show', 'TW Only Show', 'tw only show')")
      .run().lastInsertRowid
  );

  const cs1 = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_W1', 'Weekly Simulcast', 'https://www.youtube.com/playlist?list=PL_W1', 'en', 3)`
      )
      .run(chEn.id, s1Id).lastInsertRowid
  );
  const cs2 = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_S2', 'Completed Classic', 'https://www.youtube.com/playlist?list=PL_S2', 'en', 2)`
      )
      .run(chEn.id, s2Id).lastInsertRowid
  );
  const cs3 = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_TW', 'TW Only Show', 'https://www.youtube.com/playlist?list=PL_TW', 'zh-Hant', 2)`
      )
      .run(chZh.id, s3Id).lastInsertRowid
  );

  // Weekly show: EP1 (-12d), EP2 (-5d) -> EP3 predicted at +2d (inside [weekStart, weekEnd))
  const ep1At = nowSec - 12 * DAY;
  const ep2At = nowSec - 5 * DAY; // also note: weekStart is -3d, so ep2At is before weekStart
  // Add an already-released episode inside this week for TW show (-1d)
  const twEp1At = nowSec - 8 * DAY;
  const twEp2At = nowSec - 1 * DAY;

  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, published_at, is_members_only, region_allowed, details_synced_at)
     VALUES (?, ?, ?, 'vid_w_1', 'Weekly EP01', 1, 0, 'en', ?, 0, '["MY","SG"]', ?),
            (?, ?, ?, 'vid_w_2', 'Weekly EP02', 2, 1, 'en', ?, 0, '["MY","SG"]', ?),
            (?, ?, ?, 'vid_old_1', 'Old EP01', 1, 0, 'en', ?, 0, '["MY","SG"]', ?),
            (?, ?, ?, 'vid_old_2', 'Old EP02', 2, 1, 'en', ?, 0, '["MY","SG"]', ?),
            (?, ?, ?, 'vid_tw_1', 'TW EP01', 1, 0, 'zh-Hant', ?, 0, '["TW","HK"]', ?),
            (?, ?, ?, 'vid_tw_2', 'TW EP02', 2, 1, 'zh-Hant', ?, 0, '["TW","HK"]', ?)`
  ).run(
    cs1, s1Id, chEn.id, ep1At, nowSec,
    cs1, s1Id, chEn.id, ep2At, nowSec,
    cs2, s2Id, chEn.id, nowSec - 45 * DAY, nowSec,
    cs2, s2Id, chEn.id, nowSec - 38 * DAY, nowSec,
    cs3, s3Id, chZh.id, twEp1At, nowSec,
    cs3, s3Id, chZh.id, twEp2At, nowSec
  );

  // Upcoming exact YouTube premiere (+1d)
  const premiereAt = nowSec + DAY;
  db.prepare(
    `INSERT INTO live_streams (youtube_video_id, channel_id, title, status, scheduled_start_at, region_allowed, checked_at)
     VALUES ('prem_1', ?, 'Special Episode Premiere', 'upcoming', ?, '["MY","SG"]', ?)`
  ).run(chEn.id, premiereAt, nowSec);

  refreshSeriesStats(db, s1Id);
  refreshSeriesStats(db, s2Id);
  refreshSeriesStats(db, s3Id);

  // MY visitor sees: upcoming premiere (exact) + predicted Weekly Simulcast EP 3 (estimated)
  // and does NOT see Completed Classic (>21d stale) or TW Only Show (geo-filtered)
  const myCal = queryCalendar(db, {
    region: 'MY',
    startSec: weekStart,
    endSec: weekEnd,
    nowSec,
  });

  assert.equal(myCal.items.length, 2);
  assert.equal(myCal.items[0].kind, 'premiere');
  assert.equal(myCal.items[0].confidence, 'exact');
  assert.equal(myCal.items[0].airingAt, premiereAt);

  assert.equal(myCal.items[1].kind, 'predicted');
  assert.equal(myCal.items[1].confidence, 'estimated');
  assert.equal(myCal.items[1].seriesSlug, 'weekly-show');
  assert.equal(myCal.items[1].episodeNumber, 3);
  assert.equal(myCal.items[1].airingAt, ep2At + WEEK);

  // TW visitor sees TW EP02 (released) — TW EP03 (+6d) is outside weekEnd (+4d)
  const twCal = queryCalendar(db, {
    region: 'TW',
    startSec: weekStart,
    endSec: weekEnd,
    nowSec,
  });
  assert.equal(twCal.items.length, 1);
  assert.equal(twCal.items[0].kind, 'episode');
  assert.equal(twCal.items[0].status, 'released');
  assert.equal(twCal.items[0].youtubeVideoId, 'vid_tw_2');

  // If EP3 is already released early, predicted EP3 is deduplicated
  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, published_at, is_members_only, region_allowed, details_synced_at)
     VALUES (?, ?, ?, 'vid_w_3', 'Weekly EP03', 3, 2, 'en', ?, 0, '["MY","SG"]', ?)`
  ).run(cs1, s1Id, chEn.id, ep2At + WEEK - 3600, nowSec);

  const dedupCal = queryCalendar(db, {
    region: 'MY',
    startSec: weekStart,
    endSec: weekEnd,
    nowSec,
  });
  assert.equal(dedupCal.items.filter((i) => i.seriesSlug === 'weekly-show').length, 1);
  assert.equal(dedupCal.items.find((i) => i.seriesSlug === 'weekly-show')?.kind, 'episode');

  // HTTP /api/calendar & /calendar SSR routes
  const realNow = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO live_streams (youtube_video_id, channel_id, title, status, scheduled_start_at, region_allowed, checked_at)
     VALUES ('prem_http', ?, 'Live Premiere HTTP Test', 'upcoming', ?, '["MY"]', ?)`
  ).run(chEn.id, realNow + 3600, realNow);

  const app = createApp(':memory:');
  const apiRes = await app.request(`/api/calendar?region=MY&start=${realNow - DAY}&end=${realNow + 6 * DAY}`);
  assert.equal(apiRes.status, 200);
  const apiJson = (await apiRes.json()) as { items: Array<{ id: string }> };
  assert.ok(apiJson.items.some((i) => i.id === 'live:prem_http'));

  const ssrRes = await app.request('/calendar');
  assert.equal(ssrRes.status, 200);
  const ssrHtml = await ssrRes.text();
  assert.match(ssrHtml, /YouTube Anime Release Calendar/);

  closeDatabase();
});

test('queryCalendar groups same-day batch episode drops of a series into a single card', () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  const nowSec = 1795262400;

  db.prepare(
    `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, is_verified, playlist_count)
     VALUES ('UC_BATCH', '@BatchCh', 'Batch Channel', 'https://www.youtube.com/@BatchCh', '["en"]', 'anime', 'Global', 1, 1)`
  ).run();
  const ch = db.prepare("SELECT id FROM channels WHERE youtube_channel_id = 'UC_BATCH'").get() as { id: number };
  const sId = Number(
    db.prepare("INSERT INTO series (slug, canonical_title, normalized_key) VALUES ('batch-anime', 'Batch Anime', 'batch anime')").run()
      .lastInsertRowid
  );
  const csId = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_BATCH', 'Batch Anime', 'https://www.youtube.com/playlist?list=PL_BATCH', 'en', 3)`
      )
      .run(ch.id, sId).lastInsertRowid
  );

  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, published_at, is_members_only, details_synced_at)
     VALUES (?, ?, ?, 'b1', 'Batch EP01', 1, 0, 'en', ?, 0, ?),
            (?, ?, ?, 'b2', 'Batch EP02', 2, 1, 'en', ?, 0, ?),
            (?, ?, ?, 'b3', 'Batch EP03', 3, 2, 'en', ?, 0, ?)`
  ).run(
    csId, sId, ch.id, nowSec - 3600, nowSec,
    csId, sId, ch.id, nowSec - 3500, nowSec,
    csId, sId, ch.id, nowSec - 3400, nowSec
  );

  const cal = queryCalendar(db, {
    startSec: nowSec - DAY,
    endSec: nowSec + DAY,
    nowSec,
  });

  assert.equal(cal.items.length, 1);
  assert.equal(cal.items[0].batchCount, 3);
  assert.equal(cal.items[0].episodeNumber, 1);
  assert.equal(cal.items[0].episodeNumberEnd, 3);
  assert.equal(cal.items[0].youtubeVideoId, 'b1');
  assert.match(cal.items[0].episodeTitle || '', /EP 1–3/);

  closeDatabase();
});
