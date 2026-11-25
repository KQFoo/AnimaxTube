import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase, recordYouTubeQuotaUnits, refreshSeriesStats } from './db/index.ts';
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

  db.prepare(
    `INSERT INTO songs (channel_id, series_id, youtube_video_id, playlist_id, playlist_title, title, song_type, anime_title, duration_iso, view_count, like_count, published_at, region_allowed)
     VALUES (?, ?, 'song_op_1', 'PL_OPED', 'Anime OP & ED', 'Frieren Creditless Opening OP1 - Yuusha', 'op', 'Frieren', 'PT1M30S', 500000, 25000, 1700500000, '["MY","SG"]'),
            (?, ?, 'song_ed_1', 'PL_OPED', 'Anime OP & ED', 'Frieren Creditless Ending ED1 - Anytime Anywhere', 'ed', 'Frieren', 'PT1M30S', 300000, 18000, 1700400000, '["MY","SG"]'),
            (?, ?, 'song_ost_1', 'PL_OST', 'Frieren OST', 'Frieren Original Soundtrack OST - Zoltraak', 'ost', 'Frieren', 'PT3M10S', 200000, 12000, 1700300000, '["TW","HK"]')`
  ).run(ch1.id, seriesId, ch1.id, seriesId, ch2.id, seriesId);

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

  // Songs (OP, ED, OST) API: counts, type filtering, search, and geo filtering
  const songsAllRes = await app.request('/api/songs');
  assert.equal(songsAllRes.status, 200);
  const songsAllJson = (await songsAllRes.json()) as any;
  assert.equal(songsAllJson.total, 3);
  assert.deepEqual(songsAllJson.counts, { all: 3, op: 1, ed: 1, ost: 1 });
  assert.equal(songsAllJson.items[0].youtubeVideoId, 'song_op_1');

  const songsOpRes = await app.request('/api/songs?type=op');
  const songsOpJson = (await songsOpRes.json()) as any;
  assert.equal(songsOpJson.total, 1);
  assert.equal(songsOpJson.items[0].songType, 'op');

  const songsGeoRes = await app.request('/api/songs?region=MY');
  const songsGeoJson = (await songsGeoRes.json()) as any;
  assert.equal(songsGeoJson.total, 2);
  assert.deepEqual(songsGeoJson.counts, { all: 2, op: 1, ed: 1, ost: 0 });

  const songsGroupedRes = await app.request('/api/songs?group=anime');
  assert.equal(songsGroupedRes.status, 200);
  const songsGroupedJson = (await songsGroupedRes.json()) as any;
  assert.equal(songsGroupedJson.total, 1);
  assert.equal(songsGroupedJson.groups[0].trackCount, 3);
  assert.equal(songsGroupedJson.groups[0].opCount, 1);
  assert.equal(songsGroupedJson.groups[0].edCount, 1);
  assert.equal(songsGroupedJson.groups[0].ostCount, 1);
  assert.equal(songsGroupedJson.groups[0].tracks[0].songType, 'op');

  const songsPageRes = await app.request('/songs');
  assert.equal(songsPageRes.status, 200);
  assert.match(await songsPageRes.text(), /Anime Songs — Official OP, ED &amp; OST/);

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

test('Stealth /admin UI and /api/admin/* are hidden from public and allow authorized management', async () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  const prevToken = process.env.ADMIN_TOKEN;
  const triggeredSyncs: Array<{ id: string; scope?: string }> = [];
  const triggeredGlobalSyncs: Array<{ kind: string; scope?: string }> = [];
  const runNowCalls: Array<string | undefined> = [];

  try {
    delete process.env.ADMIN_TOKEN;
    const disabledApp = createApp(':memory:');
    assert.equal((await disabledApp.request('/admin')).status, 404);
    assert.equal((await disabledApp.request('/admin?token=anything-here-123456')).status, 404);
    assert.equal((await disabledApp.request('/api/admin/channels')).status, 404);

    process.env.ADMIN_TOKEN = 'super-secret-admin-token-1234';
    db.prepare(
      `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, discovery_source, is_verified, playlist_count)
       VALUES ('UC_PENDING_1', '@PendingAnime', 'Pending Anime', 'https://www.youtube.com/@PendingAnime', '["en"]', 'anime', 'Global', 'search_pending', 0, 5)`
    ).run();

    const app = createApp(':memory:', {
      admin: {
        jobs: {
          triggerLiveCheck: () => true,
          triggerChannelSync: (id?: string, scope?: string) => {
            if (id) triggeredSyncs.push({ id, scope });
            return true;
          },
          triggerIncrementalSync: (scope?: string) => {
            triggeredGlobalSyncs.push({ kind: 'incremental', scope });
            return true;
          },
          triggerFullSync: (scope?: string) => {
            triggeredGlobalSyncs.push({ kind: 'full', scope });
            return true;
          },
          triggerSongSync: () => {
            triggeredGlobalSyncs.push({ kind: 'songs' });
            return true;
          },
          triggerDiscovery: () => true,
          runQueuedNow: (jobId?: string) => {
            runNowCalls.push(jobId);
            if (jobId === 'missing') {
              return { ok: false, startedOrPromoted: null, preemptedRunningJob: null };
            }
            return {
              ok: true,
              startedOrPromoted: jobId || 'channel sync (UC_PENDING_1)',
              preemptedRunningJob: 'daily full channel & episode sync',
            };
          },
          removeQueuedJob: (jobId: string) => {
            if (jobId === 'missing') return { ok: false, removedLabel: null };
            return { ok: true, removedLabel: `queued:${jobId}` };
          },
          getStatus: () => ({
            runningJob: null,
            startedAt: null,
            lastFinishedJob: null,
            lastFinishedAt: null,
            lastExitCode: null,
            queuedCount: 0,
            queuedJobs: [],
            autoSyncEnabled: true,
            hasYouTubeApiKey: true,
            intervals: {
              liveMinutes: 30,
              incrementalHours: 4,
              channelHours: 24,
              discoveryHours: 168,
            },
            nextRunAt: {
              liveAt: 2000000000,
              incrementalAt: 2000014400,
              fullSyncAt: 2000086400,
              discoveryAt: 2000604800,
            },
          }),
          stop: () => {},
        },
        addChannel: async (targetDb, rawInput, addOpts) => {
          const res = targetDb
            .prepare(
              `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, discovery_source, is_verified, playlist_count, sync_playlists, sync_videos)
               VALUES ('UC_ADDED_BY_ADMIN', '@NewSubAnime', 'New Sub Anime', 'https://www.youtube.com/@NewSubAnime', '["en"]', 'anime', 'Global', 'manual', 1, 9, ?, ?)`
            )
            .run(addOpts.syncPlaylists === false ? 0 : 1, addOpts.syncVideos === false ? 0 : 1);
          return {
            ok: true,
            channelId: Number(res.lastInsertRowid),
            youtubeChannelId: 'UC_ADDED_BY_ADMIN',
            name: `Added ${rawInput}`,
            handle: '@NewSubAnime',
            url: 'https://www.youtube.com/@NewSubAnime',
            playlistCount: 9,
            qualifyingPlaylists: 9,
            subLanguages: ['en'],
          };
        },
        youtubeSearch: async (query, type) => [
          {
            kind: type,
            id: type === 'video' ? 'yt_song_99' : 'PL_YT_99',
            title: type === 'video' ? `${query} Creditless Opening OP1` : `${query} [Eng Sub]`,
            description: 'Official upload',
            channelId: 'UC_YT_SEARCH_1',
            channelTitle: 'Official Studio YT',
            thumbnailUrl: 'https://i.ytimg.com/vi/yt_song_99/hqdefault.jpg',
            publishedAt: '2025-01-10T00:00:00Z',
          },
        ],
        fetchChannels: async (ids) =>
          ids.map((id) => ({
            id,
            title: 'Official Studio YT',
            description: 'Official anime studio',
            customUrl: '@OfficialStudioYT',
            avatarUrl: null,
            uploadsPlaylistId: `UU${id.slice(2)}`,
            videoCount: 20,
          })),
        fetchPlaylistItems: async () => [
          {
            videoId: 'yt_ep_99_1',
            title: 'Dandadan Episode 01 [Eng Sub]',
            description: 'Official Episode 1',
            position: 0,
            thumbnailUrl: 'https://i.ytimg.com/vi/yt_ep_99_1/hqdefault.jpg',
            publishedAt: '2025-01-10T00:00:00Z',
          },
        ],
        fetchVideoDetails: async (ids) =>
          new Map(
            ids.map((id) => [
              id,
              {
                id,
                title: id === 'yt_song_99' ? 'Dandadan Creditless Opening OP1' : 'Dandadan Episode 01 [Eng Sub]',
                description: 'Official',
                publishedAt: '2025-01-10T00:00:00Z',
                durationIso: id === 'yt_song_99' ? 'PT1M30S' : 'PT24M',
                tags: ['anime'],
                defaultLanguage: 'en',
                defaultAudioLanguage: 'ja',
                viewCount: 150000,
                likeCount: 9000,
                commentCount: 300,
                privacyStatus: 'public',
                liveBroadcastContent: 'none',
                concurrentViewers: 0,
                actualStartTime: null,
                scheduledStartTime: null,
                thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                isMembersOnly: false,
                embeddable: true,
                regionAllowed: [],
                regionBlocked: [],
              },
            ])
          ),
      },
    });

    // Unauthenticated visitors get plain 404 on /admin, /admin/app.js, and /api/admin/*
    assert.equal((await app.request('/admin')).status, 404);
    assert.equal((await app.request('/admin?token=wrong-token-0000000')).status, 404);
    assert.equal((await app.request('/admin/app.js')).status, 404);
    assert.equal((await app.request('/api/admin/channels')).status, 404);
    assert.equal((await app.request('/api/admin/jobs')).status, 404);

    // Pending channel stays hidden from public /api/channels
    const pubBefore = (await (await app.request('/api/channels')).json()) as any;
    assert.equal(pubBefore.channels.length, 0);

    // Valid token query sets HttpOnly; SameSite=Strict cookie and redirects cleanly to /admin
    const loginRes = await app.request('/admin?token=super-secret-admin-token-1234');
    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.headers.get('location'), '/admin');
    const setCookie = loginRes.headers.get('set-cookie') || '';
    assert.match(setCookie, /animaxtube_admin=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookieHeader = setCookie.split(';')[0];

    // Authenticated /admin and /admin/app.js succeed with noindex/no-store
    const adminRes = await app.request('/admin', { headers: { cookie: cookieHeader } });
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.headers.get('x-robots-tag'), 'noindex, nofollow');
    const adminHtml = await adminRes.text();
    assert.match(adminHtml, /AnimaxTube Private Channel Admin/);
    assert.match(adminHtml, /id="scheduleCountdowns"/);

    const adminJsRes = await app.request('/admin/app.js', { headers: { cookie: cookieHeader } });
    assert.equal(adminJsRes.status, 200);

    const jobsRes = await app.request('/api/admin/jobs', { headers: { cookie: cookieHeader } });
    assert.equal(jobsRes.status, 200);
    const jobsJson = (await jobsRes.json()) as any;
    assert.equal(jobsJson.jobs.intervals.incrementalHours, 4);
    assert.equal(jobsJson.jobs.nextRunAt.incrementalAt, 2000014400);

    // Cookie mutation with mismatched Origin is blocked
    const csrfBlocked = await app.request('/api/admin/channels', {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        origin: 'https://evil.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channel: '@NewSubAnime' }),
    });
    assert.equal(csrfBlocked.status, 403);

    // Authenticated POST /api/admin/channels adds & queues sync with syncPlaylists + syncVideos
    const addRes = await app.request('/api/admin/channels', {
      method: 'POST',
      headers: {
        authorization: 'Bearer super-secret-admin-token-1234',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ channel: '@NewSubAnime', syncPlaylists: true, syncVideos: true }),
    });
    assert.equal(addRes.status, 200);
    const addJson = (await addRes.json()) as any;
    assert.equal(addJson.ok, true);
    assert.equal(addJson.syncQueued, true);
    assert.deepEqual(triggeredSyncs, [{ id: 'UC_ADDED_BY_ADMIN', scope: 'both' }]);

    // Approve pending candidate #1
    const approveRes = await app.request('/api/admin/channels/1/approve', {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(approveRes.status, 200);
    assert.deepEqual(triggeredSyncs, [
      { id: 'UC_ADDED_BY_ADMIN', scope: 'both' },
      { id: 'UC_PENDING_1', scope: undefined },
    ]);

    const pubAfter = (await (await app.request('/api/channels')).json()) as any;
    assert.equal(pubAfter.channels.length, 2);

    // Update per-channel sync options (videos only) and trigger sync
    const patchOptsRes = await app.request('/api/admin/channels/2/sync-options', {
      method: 'PATCH',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ syncPlaylists: false, syncVideos: true }),
    });
    assert.equal(patchOptsRes.status, 200);
    const patchOptsJson = (await patchOptsRes.json()) as any;
    assert.equal(patchOptsJson.syncPlaylists, false);
    assert.equal(patchOptsJson.syncVideos, true);

    const syncChRes = await app.request('/api/admin/channels/2/sync', {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(syncChRes.status, 200);
    const syncChJson = (await syncChRes.json()) as any;
    assert.equal(syncChJson.scope, 'videos');
    assert.deepEqual(triggeredSyncs[2], { id: 'UC_ADDED_BY_ADMIN', scope: 'videos' });

    // Disable both sync options -> sync without explicit scope returns 400
    await app.request('/api/admin/channels/2/sync-options', {
      method: 'PATCH',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ syncPlaylists: false, syncVideos: false }),
    });
    const disabledSyncRes = await app.request('/api/admin/channels/2/sync', {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(disabledSyncRes.status, 400);

    // Global sync endpoints forward scope
    const incRes = await app.request('/api/admin/sync/incremental', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'videos' }),
    });
    assert.equal(incRes.status, 200);
    const fullRes = await app.request('/api/admin/sync/full', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'playlists' }),
    });
    assert.equal(fullRes.status, 200);
    const songsSyncRes = await app.request('/api/admin/sync/songs', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(songsSyncRes.status, 200);
    assert.deepEqual(triggeredGlobalSyncs, [
      { kind: 'incremental', scope: 'videos' },
      { kind: 'full', scope: 'playlists' },
      { kind: 'songs' },
    ]);

    // Seed an exclusive series on channel #2 and a shared series across channels #1 & #2, then delete channel #2
    const exclusiveSeriesId = Number(
      db
        .prepare("INSERT INTO series (slug, canonical_title, normalized_key) VALUES ('solo-show', 'Solo Show', 'solo show')")
        .run().lastInsertRowid
    );
    const sharedSeriesId = Number(
      db
        .prepare("INSERT INTO series (slug, canonical_title, normalized_key) VALUES ('shared-show', 'Shared Show', 'shared show')")
        .run().lastInsertRowid
    );
    const csSolo = Number(
      db
        .prepare(
          "INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count) VALUES (2, ?, 'PL_SOLO', 'Solo Show', 'https://youtube.com/playlist?list=PL_SOLO', 'en', 1)"
        )
        .run(exclusiveSeriesId).lastInsertRowid
    );
    const csSharedCh1 = Number(
      db
        .prepare(
          "INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count) VALUES (1, ?, 'PL_SH1', 'Shared Show', 'https://youtube.com/playlist?list=PL_SH1', 'en', 1)"
        )
        .run(sharedSeriesId).lastInsertRowid
    );
    const csSharedCh2 = Number(
      db
        .prepare(
          "INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count) VALUES (2, ?, 'PL_SH2', 'Shared Show ZH', 'https://youtube.com/playlist?list=PL_SH2', 'zh-Hant', 1)"
        )
        .run(sharedSeriesId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, view_count)
       VALUES (?, ?, 2, 'vid_solo_1', 'Solo EP01', 1, 0, 'en', 1000),
              (?, ?, 1, 'vid_sh_1', 'Shared EP01', 1, 0, 'en', 2000),
              (?, ?, 2, 'vid_sh_2', 'Shared EP01 ZH', 1, 0, 'zh-Hant', 3000)`
    ).run(csSolo, exclusiveSeriesId, csSharedCh1, sharedSeriesId, csSharedCh2, sharedSeriesId);
    refreshSeriesStats(db, exclusiveSeriesId);
    refreshSeriesStats(db, sharedSeriesId);

    const delRes = await app.request('/api/admin/channels/2', {
      method: 'DELETE',
      headers: { cookie: cookieHeader, 'x-admin-action': '1' },
    });
    assert.equal(delRes.status, 200);
    const delJson = (await delRes.json()) as any;
    assert.equal(delJson.ok, true);
    assert.equal(delJson.deleted.deletedEpisodes, 2);
    assert.equal(delJson.deleted.removedSeriesCount, 1);
    assert.equal(delJson.deleted.updatedSeriesCount, 1);

    // Channel #2 and its videos are gone; orphaned solo series is removed; shared series is refreshed
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM channels WHERE id = 2').get() as { c: number }).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM episodes WHERE channel_id = 2').get() as { c: number }).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM series WHERE id = ?').get(exclusiveSeriesId) as { c: number }).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM series_fts WHERE series_id = ?').get(exclusiveSeriesId) as { c: number }).c, 0);
    const sharedAfter = db
      .prepare('SELECT episode_count, total_views, sub_languages FROM series WHERE id = ?')
      .get(sharedSeriesId) as { episode_count: number; total_views: number; sub_languages: string };
    assert.equal(sharedAfter.episode_count, 1);
    assert.equal(sharedAfter.total_views, 2000);
    assert.equal(sharedAfter.sub_languages, '["en"]');

    // Deleting non-existent channel returns 404
    const delMissing = await app.request('/api/admin/channels/999', {
      method: 'DELETE',
      headers: { cookie: cookieHeader, 'x-admin-action': '1' },
    });
    assert.equal(delMissing.status, 404);

    // Run a queued job immediately via /api/admin/jobs/run-now
    const runNowRes = await app.request('/api/admin/jobs/run-now', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'channel:UC_PENDING_1:default' }),
    });
    assert.equal(runNowRes.status, 200);
    const runNowJson = (await runNowRes.json()) as any;
    assert.equal(runNowJson.ok, true);
    assert.equal(runNowJson.startedOrPromoted, 'channel:UC_PENDING_1:default');
    assert.equal(runNowJson.preemptedRunningJob, 'daily full channel & episode sync');

    const runNowMissing = await app.request('/api/admin/jobs/run-now', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'missing' }),
    });
    assert.equal(runNowMissing.status, 400);
    assert.deepEqual(runNowCalls, ['channel:UC_PENDING_1:default', 'missing']);

    // List & remove specific video and specific playlist from channel #1
    const extraSeriesId = Number(
      db
        .prepare("INSERT INTO series (slug, canonical_title, normalized_key) VALUES ('extra-show', 'Extra Show', 'extra show')")
        .run().lastInsertRowid
    );
    const csExtra = Number(
      db
        .prepare(
          "INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count) VALUES (1, ?, 'PL_EXTRA', 'Extra Show Playlist', 'https://youtube.com/playlist?list=PL_EXTRA', 'en', 2)"
        )
        .run(extraSeriesId).lastInsertRowid
    );
    const ep1Id = Number(
      db
        .prepare(
          "INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, view_count) VALUES (?, ?, 1, 'vid_extra_1', 'Extra EP01', 1, 0, 'en', 500)"
        )
        .run(csExtra, extraSeriesId).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, view_count) VALUES (?, ?, 1, 'vid_extra_2', 'Extra EP02', 2, 1, 'en', 700)"
    ).run(csExtra, extraSeriesId);
    refreshSeriesStats(db, extraSeriesId);

    const plListRes = await app.request('/api/admin/channels/1/playlists', {
      headers: { cookie: cookieHeader },
    });
    assert.equal(plListRes.status, 200);
    const plListJson = (await plListRes.json()) as any;
    assert.ok(plListJson.playlists.some((p: any) => p.id === csExtra && p.episodeCount === 2));

    const vidListRes = await app.request(`/api/admin/channels/1/videos?channelSeriesId=${csExtra}`, {
      headers: { cookie: cookieHeader },
    });
    assert.equal(vidListRes.status, 200);
    const vidListJson = (await vidListRes.json()) as any;
    assert.equal(vidListJson.total, 2);
    assert.equal(vidListJson.videos.length, 2);

    // Delete a single video from channel #1 -> playlist & series remain with 1 episode
    const delVidRes = await app.request(`/api/admin/channels/1/videos/${ep1Id}`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader, 'x-admin-action': '1' },
    });
    assert.equal(delVidRes.status, 200);
    const delVidJson = (await delVidRes.json()) as any;
    assert.equal(delVidJson.deleted.removedPlaylist, false);
    assert.equal(delVidJson.deleted.removedSeries, false);
    const extraSeriesMid = db
      .prepare('SELECT episode_count, total_views FROM series WHERE id = ?')
      .get(extraSeriesId) as { episode_count: number; total_views: number };
    assert.equal(extraSeriesMid.episode_count, 1);
    assert.equal(extraSeriesMid.total_views, 700);

    // Delete the playlist from channel #1 -> remaining video and orphaned series are removed
    const delPlRes = await app.request(`/api/admin/channels/1/playlists/${csExtra}`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader, 'x-admin-action': '1' },
    });
    assert.equal(delPlRes.status, 200);
    const delPlJson = (await delPlRes.json()) as any;
    assert.equal(delPlJson.deleted.deletedEpisodes, 1);
    assert.equal(delPlJson.deleted.removedSeries, true);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM channel_series WHERE id = ?').get(csExtra) as { c: number }).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM series WHERE id = ?').get(extraSeriesId) as { c: number }).c, 0);

    // Deleting a playlist/video that does not belong to channel #1 returns 404
    const delPlMissing = await app.request(`/api/admin/channels/1/playlists/${csExtra}`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader, 'x-admin-action': '1' },
    });
    assert.equal(delPlMissing.status, 404);
    const delVidMissing = await app.request(`/api/admin/channels/1/videos/${ep1Id}`, {
      method: 'DELETE',
      headers: { cookie: cookieHeader, 'x-admin-action': '1' },
    });
    assert.equal(delVidMissing.status, 404);

    // Admin session check & YouTube search + inline import (anime playlist & song)
    assert.equal((await app.request('/api/admin/session')).status, 404);
    const sessionRes = await app.request('/api/admin/session', { headers: { cookie: cookieHeader } });
    assert.equal(sessionRes.status, 200);
    assert.equal(((await sessionRes.json()) as any).isAdmin, true);

    const ytAnimeRes = await app.request('/api/admin/youtube/search?mode=anime&q=Dandadan', {
      headers: { cookie: cookieHeader },
    });
    assert.equal(ytAnimeRes.status, 200);
    const ytAnimeJson = (await ytAnimeRes.json()) as any;
    assert.equal(ytAnimeJson.results[0].id, 'PL_YT_99');

    const importPlRes = await app.request('/api/admin/youtube/import-playlist', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({
        playlistId: 'PL_YT_99',
        playlistTitle: 'Dandadan [Eng Sub]',
        channelId: 'UC_YT_SEARCH_1',
        channelTitle: 'Official Studio YT',
      }),
    });
    assert.equal(importPlRes.status, 200);
    const importPlJson = (await importPlRes.json()) as any;
    assert.equal(importPlJson.importedEpisodes, 1);

    const ytSongsRes = await app.request('/api/admin/youtube/search?mode=songs&q=Dandadan', {
      headers: { cookie: cookieHeader },
    });
    assert.equal(ytSongsRes.status, 200);
    const ytSongsJson = (await ytSongsRes.json()) as any;
    assert.equal(ytSongsJson.results[0].suggestedSongType, 'op');

    const importSongRes = await app.request('/api/admin/youtube/import-song', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({
        videoId: 'yt_song_99',
        title: 'Dandadan Creditless Opening OP1',
        channelId: 'UC_YT_SEARCH_1',
        channelTitle: 'Official Studio YT',
        songType: 'op',
      }),
    });
    assert.equal(importSongRes.status, 200);
    const importSongJson = (await importSongRes.json()) as any;
    assert.equal(importSongJson.song.songType, 'op');

    const songsCheck = (await (await app.request('/api/songs?q=Dandadan')).json()) as any;
    assert.equal(songsCheck.total, 1);
    assert.equal(songsCheck.items[0].youtubeVideoId, 'yt_song_99');

    // Queued job removal + YouTube daily quota tracking
    const removeQRes = await app.request('/api/admin/jobs/remove', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'songs' }),
    });
    assert.equal(removeQRes.status, 200);
    assert.equal(((await removeQRes.json()) as any).removedLabel, 'queued:songs');

    const removeQMissing = await app.request('/api/admin/jobs/remove', {
      method: 'POST',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'missing' }),
    });
    assert.equal(removeQMissing.status, 404);

    const prevYtKey = process.env.YOUTUBE_API_KEY;
    try {
      process.env.YOUTUBE_API_KEY = 'fake-test-youtube-key';
      recordYouTubeQuotaUnits(db, 350);
      const quotaRes = await app.request('/api/admin/jobs', { headers: { cookie: cookieHeader } });
      assert.equal(quotaRes.status, 200);
      const quotaJson = (await quotaRes.json()) as any;
      assert.equal(quotaJson.quota.usedToday, 350);
      assert.equal(quotaJson.quota.remaining, quotaJson.quota.dailyLimit - 350);
      assert.ok(quotaJson.quota.dailyLimit >= 10000);
    } finally {
      if (prevYtKey === undefined) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = prevYtKey;
    }
  } finally {
    if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prevToken;
    closeDatabase();
  }
});
