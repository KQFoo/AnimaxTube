import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  normalizeRegionCode,
  openDatabase,
  queryChannelsList,
  queryHealth,
  querySeriesList,
  queryTopTags,
  refreshSeriesStats,
} from './index.ts';
import { compactDatabase } from './compact.ts';
import { ensureSeedDatabase } from './seed.ts';
import { createApp } from '../server.ts';
import { safeHttpUrl } from '../seo.ts';

test('series_tags and region caches accelerate tag/geo queries and invalidate on changes', async () => {
  closeDatabase();
  const db = openDatabase(':memory:');

  const chId = Number(
    db
      .prepare(
        `INSERT INTO channels (youtube_channel_id, handle, name, url, sub_languages, category, region_focus, is_verified, playlist_count)
         VALUES ('UC_CACHE_1', '@CacheCh', 'Cache Channel', 'https://youtube.com/@CacheCh', '["en"]', 'anime', 'SEA', 1, 1)`
      )
      .run().lastInsertRowid
  );

  const s1 = Number(
    db
      .prepare(
        `INSERT INTO series (slug, canonical_title, normalized_key, genres, tags)
         VALUES ('cache-isekai', 'Cache Isekai', 'cache isekai', '["Fantasy","Action"]', '["Fantasy","Isekai"]')`
      )
      .run().lastInsertRowid
  );
  const s2 = Number(
    db
      .prepare(
        `INSERT INTO series (slug, canonical_title, normalized_key, genres, tags)
         VALUES ('cache-sol', 'Cache Slice of Life', 'cache slice of life', '["Slice of Life"]', '["Slice of Life"]')`
      )
      .run().lastInsertRowid
  );

  const cs1 = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_C1', 'Cache Isekai', 'https://youtube.com/playlist?list=PL_C1', 'en', 2)`
      )
      .run(chId, s1).lastInsertRowid
  );
  const cs2 = Number(
    db
      .prepare(
        `INSERT INTO channel_series (channel_id, series_id, playlist_id, playlist_title, playlist_url, sub_language, episode_count)
         VALUES (?, ?, 'PL_C2', 'Cache Slice of Life', 'https://youtube.com/playlist?list=PL_C2', 'en', 1)`
      )
      .run(chId, s2).lastInsertRowid
  );

  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, is_members_only, tags, region_allowed, details_synced_at)
     VALUES (?, ?, ?, 'c_v1', 'EP 1', 1, 0, 'en', 0, '["Isekai"]', '["MY"]', 1700000000),
            (?, ?, ?, 'c_v2', 'EP 2', 2, 1, 'en', 0, '["Action"]', '["MY"]', 1700000000)`
  ).run(cs1, s1, chId, cs1, s1, chId);

  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, is_members_only, tags, region_allowed, details_synced_at)
     VALUES (?, ?, ?, 'c_v3', 'SOL EP 1', 1, 0, 'en', 0, '[]', '["US"]', 1700000000)`
  ).run(cs2, s2, chId);

  refreshSeriesStats(db, s1);
  refreshSeriesStats(db, s2);

  const myHealth = queryHealth(db, 'MY');
  assert.equal(myHealth.series, 1);
  assert.equal(myHealth.episodes, 2);
  assert.equal(myHealth.channels, 1);

  const usChannels = queryChannelsList(db, 'US');
  assert.equal(usChannels[0].seriesCount, 1);
  assert.equal(usChannels[0].totalEpisodes, 1);

  const tagFiltered = querySeriesList(db, { tag: 'isekai', region: 'MY' });
  assert.equal(tagFiltered.total, 1);
  assert.equal(tagFiltered.items[0].slug, 'cache-isekai');

  const topTagsMy = queryTopTags(db, 10, 'MY');
  assert.ok(topTagsMy.some((t) => t.tag.toLowerCase() === 'fantasy'));
  assert.ok(!topTagsMy.some((t) => t.tag.toLowerCase() === 'slice of life'));

  // Trigger invalidation when a new MY episode unlocks on s2
  db.prepare(
    `INSERT INTO episodes (channel_series_id, series_id, channel_id, youtube_video_id, title, episode_number, playlist_position, sub_language, is_members_only, tags, region_allowed, details_synced_at)
     VALUES (?, ?, ?, 'c_v4', 'SOL EP 2', 2, 1, 'en', 0, '[]', '["MY"]', 1700000000)`
  ).run(cs2, s2, chId);
  refreshSeriesStats(db, s2);

  const myHealthAfter = queryHealth(db, 'MY');
  assert.equal(myHealthAfter.series, 2);
  assert.equal(myHealthAfter.episodes, 3);

  const app = createApp(':memory:');
  const gzipRes = await app.request('/api/series?region=MY', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(gzipRes.status, 200);
  assert.equal(gzipRes.headers.get('content-encoding'), 'gzip');
  assert.match(gzipRes.headers.get('cache-control') || '', /max-age=60/);

  const geoRes = await app.request('/api/geo', {
    headers: { 'cf-ipcountry': 'MY' },
  });
  assert.equal(geoRes.status, 200);
  assert.equal(geoRes.headers.get('cache-control'), 'private, no-store');

  closeDatabase();
});

test('security hardening: headers, CSP, region validation, URL sanitization, input bounds, and rate limit', async () => {
  assert.equal(normalizeRegionCode('my'), 'MY');
  assert.equal(normalizeRegionCode('US'), 'US');
  assert.equal(normalizeRegionCode('ZZ'), null);
  assert.equal(normalizeRegionCode('XX'), null);
  assert.equal(normalizeRegionCode('AA'), null);
  assert.equal(normalizeRegionCode('123'), null);
  assert.equal(normalizeRegionCode(null), null);

  assert.equal(safeHttpUrl('https://i.ytimg.com/vi/abc/hqdefault.jpg'), 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
  assert.equal(safeHttpUrl('http://localhost:3000/img.png'), 'http://localhost:3000/img.png');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeHttpUrl('//evil.example/a.jpg'), null);

  closeDatabase();
  const app = createApp(':memory:', { rateLimitPerMin: 3 });

  const htmlRes = await app.request('/', {
    headers: {
      Host: 'bad host!evil',
      'X-Forwarded-Proto': 'https',
    },
  });
  assert.equal(htmlRes.status, 200);
  assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(htmlRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(htmlRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.ok(htmlRes.headers.get('permissions-policy'));
  assert.equal(htmlRes.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.match(htmlRes.headers.get('strict-transport-security') || '', /max-age=31536000/);

  const csp = htmlRes.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/www\.youtube\.com https:\/\/s\.ytimg\.com/);
  const scriptSrcDirective = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('script-src'));
  assert.ok(scriptSrcDirective && !scriptSrcDirective.includes('unsafe-inline'));

  const htmlText = await htmlRes.text();
  assert.ok(!htmlText.includes('bad host!evil'));

  // Malformed URI encoding returns 400 rather than throwing unhandled URIError
  const badSlugRes = await app.request('/api/series/%E0%A4%A', {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.equal(badSlugRes.status, 400);

  // Oversized limit is clamped cleanly
  const tagsRes = await app.request('/api/tags?limit=999999', {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.equal(tagsRes.status, 200);

  // Third request passes, fourth within window gets 429 + Retry-After
  const okRes = await app.request('/api/health', {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.equal(okRes.status, 200);

  const limitedRes = await app.request('/api/health', {
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.equal(limitedRes.status, 429);
  assert.ok(limitedRes.headers.get('retry-after'));

  closeDatabase();
});

test('compactDatabase checkpoints WAL into main sqlite file and ensureSeedDatabase restores .db.gz', async () => {
  closeDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animax-compact-'));
  const dbPath = path.join(dir, 'test.db');
  const seededPath = path.join(dir, 'restored.db');
  let server: http.Server | null = null;
  try {
    const db = openDatabase(dbPath);
    db.prepare(
      `INSERT INTO series (slug, canonical_title, normalized_key)
       VALUES ('compact-test', 'Compact Test', 'compact test')`
    ).run();
    // Force dirty WAL pages without checkpointing before calling compactDatabase
    assert.ok(fs.existsSync(`${dbPath}-wal`));

    const result = await compactDatabase(dbPath, { gzip: true });
    assert.equal(result.dbPath, dbPath);
    assert.ok(result.afterBytes > 0);
    assert.equal(result.walBytesAfter, 0);
    assert.ok(result.gzipPath && (result.gzipBytes || 0) > 0);

    // Serve the .gz file over local HTTP and restore into a brand-new path
    server = http.createServer((req, res) => {
      if (req.url === '/animaxtube.db.gz') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        fs.createReadStream(result.gzipPath!).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('not sqlite');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };

    // Invalid payload is rejected and leaves no partial file
    await assert.rejects(
      ensureSeedDatabase(seededPath, `http://127.0.0.1:${addr.port}/bad.txt`),
      /not a valid SQLite 3 database/
    );
    assert.equal(fs.existsSync(seededPath), false);

    // Valid .db.gz streams, decompresses, and opens cleanly
    const seeded = await ensureSeedDatabase(seededPath, `http://127.0.0.1:${addr.port}/animaxtube.db.gz`);
    assert.equal(seeded, true);
    assert.equal(await ensureSeedDatabase(seededPath, `http://127.0.0.1:${addr.port}/bad.txt`), false);

    const reopened = openDatabase(seededPath);
    const row = reopened
      .prepare(`SELECT canonical_title FROM series WHERE slug = 'compact-test'`)
      .get() as { canonical_title: string } | undefined;
    assert.equal(row?.canonical_title, 'Compact Test');
  } finally {
    closeDatabase();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
