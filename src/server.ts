import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Hono, type Context } from 'hono';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  closeDatabase,
  getDbPath,
  normalizeRegionCode,
  openDatabase,
  queryChannelsList,
  queryHealth,
  queryLiveStreams,
  querySeriesDetail,
  querySeriesList,
  querySongGroups,
  querySongsList,
  queryTopTags,
  queryVideosSearch,
} from './db/index.ts';
import { queryCalendar } from './db/calendar.ts';
import { ensureSeedDatabase } from './db/seed.ts';
import { queryCommentRecommendations, queryForYou, queryTrending, queryUnlockedSeries } from './db/recommend.ts';
import { registerAdminRoutes, type AdminRoutesOptions } from './admin.ts';
import { startBackgroundSyncScheduler } from './lib/scheduler.ts';
import { buildPageMeta, renderIndexHtml } from './seo.ts';

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const HOST_RE = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveSafeOrigin(reqUrl: URL): string {
  const configured = process.env.PUBLIC_ORIGIN?.replace(/\/+$/, '');
  if (configured) return configured;
  const proto = reqUrl.protocol === 'https:' ? 'https:' : 'http:';
  const host = HOST_RE.test(reqUrl.host) ? reqUrl.host : 'localhost';
  return `${proto}//${host}`;
}

function getClientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'local'
  );
}

function parseSlugList(raw: string | undefined, max: number): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 200)
    .slice(0, max);
}

export interface AppOptions {
  rateLimitPerMin?: number;
  admin?: AdminRoutesOptions;
}

export function createApp(dbPath?: string, opts: AppOptions = {}) {
  const db = openDatabase(dbPath);
  const app = new Hono();

  const generalRateMax = opts.rateLimitPerMin ?? 240;
  const heavyRateMax = Math.min(generalRateMax, 30);
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();

  const checkRateLimit = (key: string, max: number): { allowed: boolean; retryAfter: number } => {
    const now = Date.now();
    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) {
        if (v.resetAt <= now) rateBuckets.delete(k);
      }
      if (rateBuckets.size > 5000) rateBuckets.clear();
    }
    const cur = rateBuckets.get(key);
    if (!cur || cur.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfter: 0 };
    }
    if (cur.count >= max) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
    }
    cur.count += 1;
    return { allowed: true, retryAfter: 0 };
  };

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')) {
      c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const ct = c.res.headers.get('content-type') || '';
    if (!c.req.path.startsWith('/api/') && (ct.includes('text/html') || ct === '')) {
      c.res.headers.set('Content-Security-Policy', CSP_HEADER);
    }
  });

  app.use('*', compress());
  app.use('/api/*', async (c, next) => {
    const ip = getClientIp(c);
    const isHeavy = c.req.path === '/api/recommendations/for-you';
    const rl = checkRateLimit(`${ip}:${isHeavy ? 'heavy' : 'api'}`, isHeavy ? heavyRateMax : generalRateMax);
    if (!rl.allowed) {
      c.res.headers.set('Retry-After', String(rl.retryAfter));
      return c.json({ error: 'Too many requests' }, 429);
    }
    await next();
    if (c.req.method === 'GET' && c.res.status === 200) {
      const cacheValue =
        c.req.path === '/api/geo' || c.req.path.startsWith('/api/admin/')
          ? 'private, no-store'
          : 'public, max-age=60, stale-while-revalidate=300';
      c.res.headers.set('Cache-Control', cacheValue);
    }
  });

  app.get('/api/geo', (c) => {
    const rawHeader =
      c.req.header('cf-ipcountry') ||
      c.req.header('x-vercel-ip-country') ||
      c.req.header('x-country-code') ||
      null;
    return c.json({ region: normalizeRegionCode(rawHeader) });
  });

  app.get('/api/health', (c) => {
    const region = c.req.query('region') || null;
    return c.json({ ok: true, ...queryHealth(db, region) });
  });

  app.get('/api/channels', (c) => {
    const region = c.req.query('region') || null;
    const channels = queryChannelsList(db, region);
    return c.json({ channels });
  });

  app.get('/api/tags', (c) => {
    const limit = clampInt(c.req.query('limit'), 20, 1, 50);
    const region = c.req.query('region') || null;
    return c.json({ tags: queryTopTags(db, limit, region) });
  });

  app.get('/api/live', (c) => {
    const region = c.req.query('region') || null;
    return c.json({ streams: queryLiveStreams(db, region) });
  });

  app.get('/api/songs', (c) => {
    const typeRaw = c.req.query('type');
    const type = typeRaw === 'op' || typeRaw === 'ed' || typeRaw === 'ost' ? typeRaw : 'all';
    const q = c.req.query('q')?.slice(0, 120) || undefined;
    const channelRaw = c.req.query('channel');
    const channelId = channelRaw ? parseInt(channelRaw, 10) || undefined : undefined;
    const region = c.req.query('region') || null;
    const sortRaw = c.req.query('sort');
    const sort = sortRaw === 'recent' || sortRaw === 'az' ? sortRaw : 'views';
    const page = clampInt(c.req.query('page'), 1, 1, 10_000);
    const limit = clampInt(c.req.query('limit'), 36, 1, 100);
    if (c.req.query('group') === 'anime') {
      return c.json(querySongGroups(db, { type, q, channelId, region, sort, page, limit }));
    }
    return c.json(querySongsList(db, { type, q, channelId, region, sort, page, limit }));
  });

  app.get('/api/videos', (c) => {
    const q = c.req.query('q')?.slice(0, 120) || '';
    const region = c.req.query('region') || null;
    const channelRaw = c.req.query('channel');
    const channelId = channelRaw ? parseInt(channelRaw, 10) || undefined : undefined;
    const limit = clampInt(c.req.query('limit'), 16, 1, 48);
    return c.json(queryVideosSearch(db, { q, region, channelId, limit }));
  });

  app.get('/api/calendar', (c) => {
    const region = c.req.query('region') || null;
    const lang = c.req.query('lang') || 'all';
    const channelRaw = c.req.query('channel');
    const channelId = channelRaw ? parseInt(channelRaw, 10) || undefined : undefined;
    const startRaw = c.req.query('start');
    const endRaw = c.req.query('end');
    const startSec = startRaw ? parseInt(startRaw, 10) : undefined;
    const endSec = endRaw ? parseInt(endRaw, 10) : undefined;
    return c.json(
      queryCalendar(db, {
        region,
        lang,
        channelId,
        startSec: Number.isFinite(startSec) ? startSec : undefined,
        endSec: Number.isFinite(endSec) ? endSec : undefined,
      })
    );
  });

  app.get('/api/unlocked', (c) => {
    const limit = clampInt(c.req.query('limit'), 16, 1, 48);
    const region = c.req.query('region') || null;
    return c.json({ items: queryUnlockedSeries(db, limit, region) });
  });

  app.get('/api/trending', (c) => {
    const limit = clampInt(c.req.query('limit'), 16, 1, 48);
    const region = c.req.query('region') || null;
    return c.json({ items: queryTrending(db, limit, region) });
  });

  app.get('/api/recommendations', (c) => {
    const region = c.req.query('region') || null;
    return c.json(queryCommentRecommendations(db, region));
  });

  app.get('/api/recommendations/for-you', (c) => {
    const region = c.req.query('region') || null;
    const seeds = parseSlugList(c.req.query('seeds'), 5);
    const exclude = parseSlugList(c.req.query('exclude'), 300);
    return c.json({ rows: queryForYou(db, { seeds, exclude, region }) });
  });

  app.get('/api/series', (c) => {
    const q = c.req.query('q')?.slice(0, 120) || undefined;
    const lang = c.req.query('lang') || 'all';
    const tag = c.req.query('tag')?.slice(0, 64) || undefined;
    const region = c.req.query('region') || undefined;
    const channelRaw = c.req.query('channel');
    const channelId = channelRaw ? parseInt(channelRaw, 10) || undefined : undefined;
    const sortRaw = c.req.query('sort');
    const sort =
      sortRaw === 'views' || sortRaw === 'episodes' || sortRaw === 'az' ? sortRaw : 'recent';
    const page = clampInt(c.req.query('page'), 1, 1, 10_000);
    const limit = clampInt(c.req.query('limit'), 36, 1, 100);

    const result = querySeriesList(db, { q, lang, tag, channelId, region, sort, page, limit });
    return c.json(result);
  });

  app.get('/api/series/:slug', (c) => {
    let slug: string;
    try {
      slug = decodeURIComponent(c.req.param('slug'));
    } catch {
      return c.json({ error: 'Invalid series slug' }, 400);
    }
    if (!slug || slug.length > 200) {
      return c.json({ error: 'Invalid series slug' }, 400);
    }
    const region = c.req.query('region') || null;
    const detail = querySeriesDetail(db, slug, region);
    if (!detail) {
      return c.json({ error: 'Series not found' }, 404);
    }
    return c.json(detail);
  });

  const renderShell = (c: Context) => {
    const indexPath = path.resolve(process.cwd(), 'public', 'index.html');
    if (!fs.existsSync(indexPath)) {
      return c.text('AnimaxTube frontend not found', 404);
    }
    const url = new URL(c.req.url);
    const origin = resolveSafeOrigin(url);
    const meta = buildPageMeta(db, url.pathname);
    const html = renderIndexHtml(fs.readFileSync(indexPath, 'utf8'), meta, { origin });
    return c.html(html, meta.noindex && url.pathname.startsWith('/watch/') ? 404 : 200);
  };

  registerAdminRoutes(app, db, opts.admin);

  // HTML routes are rendered server-side so crawlers see per-page titles/meta without running JS.
  app.get('/', renderShell);
  app.get('/index.html', renderShell);

  app.use('/*', serveStatic({ root: './public' }));

  app.get('*', renderShell);

  return app;
}

const isDirect =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  (async () => {
    await ensureSeedDatabase(getDbPath());

    const port = parseInt(process.env.PORT || '3000', 10) || 3000;
    const db = openDatabase();
    const scheduler = startBackgroundSyncScheduler(db);
    const app = createApp(undefined, { admin: { jobs: scheduler } });
    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`AnimaxTube server listening on http://localhost:${port}`);
    });

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}; closing AnimaxTube gracefully...`);
      scheduler.stop();
      const forceTimer = setTimeout(() => {
        closeDatabase();
        process.exit(0);
      }, 5000);
      forceTimer.unref();
      server.close(() => {
        clearTimeout(forceTimer);
        closeDatabase();
        process.exit(0);
      });
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  })().catch((err) => {
    console.error('AnimaxTube startup failed:', err);
    closeDatabase();
    process.exit(1);
  });
}
