import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import {
  addOrUpdateSingleChannel,
  type AddChannelOptions,
  type AddChannelResult,
  type ChannelCategory,
  type SubLangHint,
} from './discovery/add-channel.ts';
import type { JobCoordinator } from './lib/scheduler.ts';

const COOKIE_NAME = 'animaxtube_admin';
const SESSION_TTL_SEC = 7 * 24 * 3600;

export interface AdminRoutesOptions {
  jobs?: JobCoordinator;
  addChannel?: (db: DatabaseSync, rawInput: string, opts: AddChannelOptions) => Promise<AddChannelResult>;
}

function getConfiguredAdminToken(): string | null {
  const token = (process.env.ADMIN_TOKEN || '').trim();
  return token.length >= 16 ? token : null;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function timingSafeTextEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function signSessionValue(expiresAtSec: number, secret: string): string {
  const payload = String(expiresAtSec);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySessionValue(rawCookie: string | undefined, secret: string): boolean {
  if (!rawCookie) return false;
  const dot = rawCookie.indexOf('.');
  if (dot <= 0) return false;
  const payload = rawCookie.slice(0, dot);
  const providedSig = rawCookie.slice(dot + 1);
  const exp = parseInt(payload, 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return false;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return timingSafeTextEqual(providedSig, expectedSig);
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function isHttpsRequest(c: Context): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://');
}

function setSessionCookie(c: Context, secret: string, clear = false): void {
  const secure = isHttpsRequest(c) ? '; Secure' : '';
  if (clear) {
    c.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    return;
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const val = encodeURIComponent(signSessionValue(exp, secret));
  c.header(
    'Set-Cookie',
    `${COOKIE_NAME}=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}${secure}`
  );
}

function authenticateRequest(c: Context): { ok: boolean; viaCookie: boolean; token: string | null } {
  const secret = getConfiguredAdminToken();
  if (!secret) return { ok: false, viaCookie: false, token: null };

  const authHeader = c.req.header('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const candidate = authHeader.slice('Bearer '.length).trim();
    if (candidate && timingSafeTextEqual(candidate, secret)) {
      return { ok: true, viaCookie: false, token: secret };
    }
    return { ok: false, viaCookie: false, token: null };
  }

  const cookieVal = parseCookie(c.req.header('cookie'), COOKIE_NAME);
  if (verifySessionValue(cookieVal, secret)) {
    return { ok: true, viaCookie: true, token: secret };
  }

  return { ok: false, viaCookie: false, token: null };
}

function verifySameOriginForCookieMutation(c: Context): boolean {
  const origin = c.req.header('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const reqHost = c.req.header('host') || new URL(c.req.url).host;
      if (originHost !== reqHost) return false;
    } catch {
      return false;
    }
  }
  return c.req.header('x-admin-action') === '1' || (c.req.header('content-type') || '').includes('application/json');
}

function stealthHeaders(c: Context): void {
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  c.res.headers.set('Cache-Control', 'private, no-store');
}

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>AnimaxTube Channel Admin</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1016;
      --card: #151b26;
      --border: #263042;
      --text: #edf2f7;
      --muted: #98a4b8;
      --accent: #3ea6ff;
      --good: #2ecc71;
      --warn: #f39c12;
      --bad: #e74c3c;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--text); }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
    h1 { font-size: 20px; margin: 0; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    button { background: #212b3d; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 12px; cursor: pointer; font-size: 13px; }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--accent); color: #08111b; border-color: var(--accent); font-weight: 600; }
    button.danger { border-color: #6b2d2d; color: #ff8e83; }
    button:disabled { opacity: 0.5; cursor: wait; }
    form.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; align-items: end; }
    label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
    input, select { background: #0b0e14; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
    .check-row { flex-direction: row; align-items: center; gap: 8px; padding-bottom: 8px; color: var(--text); }
    .stats { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; color: var(--muted); }
    .stats strong { color: var(--text); }
    .status { font-size: 13px; margin-top: 10px; min-height: 18px; color: var(--accent); }
    .status.error { color: var(--bad); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    th { color: var(--muted); font-weight: 500; }
    .ch-cell { display: flex; align-items: center; gap: 8px; }
    .ch-cell img { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; background: #0b0e14; }
    a { color: var(--accent); text-decoration: none; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); color: var(--muted); }
    .badge.pending { color: var(--warn); border-color: #6b4e18; }
    .badge.rejected { color: var(--bad); border-color: #6b2d2d; }
    .badge.ok { color: var(--good); border-color: #1f5c39; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>AnimaxTube Private Channel Admin</h1>
      <div class="toolbar">
        <button id="btnIncSync">Run 4h Incremental Sync</button>
        <button id="btnFullSync">Run Full Sync</button>
        <button id="btnLiveSync">Check Live</button>
        <button id="btnDiscover">Scan Candidates (~600 quota)</button>
        <button id="btnRefresh">Refresh</button>
        <button id="btnLogout" class="danger">Sign Out</button>
      </div>
    </header>

    <section class="card">
      <div id="summaryStats" class="stats">Loading status...</div>
      <div id="actionStatus" class="status"></div>
    </section>

    <section class="card">
      <h2>Add &amp; Sync Official YouTube Channel</h2>
      <form id="addChannelForm" class="grid">
        <label style="grid-column: span 2;">
          YouTube Channel URL, @handle, or UC... ID
          <input id="chInput" type="text" placeholder="https://www.youtube.com/@MuseAsia or @handle" required />
        </label>
        <label>
          Category
          <select id="chCategory">
            <option value="">Auto-detect</option>
            <option value="anime">anime</option>
            <option value="donghua">donghua</option>
            <option value="studio">studio</option>
          </select>
        </label>
        <label>
          Region Focus (optional)
          <input id="chRegion" type="text" placeholder="Asia / Global" />
        </label>
        <label>
          Sub Languages (comma separated)
          <input id="chLangs" type="text" placeholder="en,zh-Hant" />
        </label>
        <label class="check-row">
          <input id="chForce" type="checkbox" />
          Force add (&lt;2 playlists)
        </label>
        <button id="btnAddChannel" type="submit" class="primary">Add &amp; Sync Channel</button>
      </form>
    </section>

    <section class="card">
      <h2>Candidate Review Queue (<span id="pendingCount">0</span>)</h2>
      <div id="candidatesWrap">Loading...</div>
    </section>

    <section class="card">
      <h2>Verified Channels (<span id="verifiedCount">0</span>)</h2>
      <div id="verifiedWrap">Loading...</div>
    </section>
  </main>
  <script src="/admin/app.js"></script>
</body>
</html>`;

const ADMIN_APP_JS = `(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('actionStatus');

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || '';
    statusEl.className = isError ? 'status error' : 'status';
  }

  function fmtTime(unixSec) {
    if (!unixSec) return 'never';
    return new Date(unixSec * 1000).toLocaleString();
  }

  async function api(url, method = 'GET', body) {
    const opts = {
      method,
      headers: {
        'X-Admin-Action': '1',
      },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, String(v));
    }
    for (const child of children) {
      if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else if (child) node.appendChild(child);
    }
    return node;
  }

  function channelCell(ch) {
    const img = ch.avatarUrl ? el('img', { src: ch.avatarUrl, alt: '' }) : null;
    const link = el('a', { href: ch.url, target: '_blank', rel: 'noopener noreferrer', text: ch.name });
    return el('div', { className: 'ch-cell' }, img, el('div', {}, link, el('div', { style: 'font-size:11px;color:#98a4b8', text: ch.handle || ch.youtubeChannelId })));
  }

  function renderCandidates(list) {
    const wrap = $('candidatesWrap');
    $('pendingCount').textContent = String(list.filter((c) => c.discoverySource !== 'rejected').length);
    wrap.textContent = '';
    if (!list.length) {
      wrap.appendChild(el('div', { style: 'color:#98a4b8;font-size:13px', text: 'No pending or rejected candidates.' }));
      return;
    }
    const tbody = el('tbody');
    for (const ch of list) {
      const badgeCls = ch.discoverySource === 'rejected' ? 'badge rejected' : 'badge pending';
      const approveBtn = el('button', { className: 'primary', text: 'Approve & Sync' });
      approveBtn.onclick = async () => {
        try {
          setStatus('Approving ' + ch.name + '...');
          await api('/api/admin/channels/' + ch.id + '/approve', 'POST', {});
          setStatus('Approved ' + ch.name + ' and queued sync.');
          await loadState();
        } catch (err) { setStatus(err.message, true); }
      };
      const rejectBtn = ch.discoverySource === 'rejected'
        ? null
        : el('button', { className: 'danger', text: 'Reject' });
      if (rejectBtn) {
        rejectBtn.onclick = async () => {
          try {
            await api('/api/admin/channels/' + ch.id + '/reject', 'POST', {});
            setStatus('Rejected ' + ch.name + '.');
            await loadState();
          } catch (err) { setStatus(err.message, true); }
        };
      }
      tbody.appendChild(el('tr', {},
        el('td', {}, channelCell(ch)),
        el('td', {}, el('span', { className: badgeCls, text: ch.discoverySource })),
        el('td', { text: ch.subLanguages.join(', ') }),
        el('td', { text: String(ch.playlistCount) }),
        el('td', {}, el('div', { className: 'actions' }, approveBtn, rejectBtn))
      ));
    }
    wrap.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Channel' }),
        el('th', { text: 'Status' }),
        el('th', { text: 'Langs' }),
        el('th', { text: 'Playlists' }),
        el('th', { text: 'Actions' })
      )),
      tbody
    ));
  }

  function renderVerified(list) {
    const wrap = $('verifiedWrap');
    $('verifiedCount').textContent = String(list.length);
    wrap.textContent = '';
    const tbody = el('tbody');
    for (const ch of list) {
      const syncBtn = el('button', { text: 'Sync Now' });
      syncBtn.onclick = async () => {
        try {
          const out = await api('/api/admin/channels/' + ch.id + '/sync', 'POST', {});
          setStatus(out.queued ? 'Queued sync for ' + ch.name + '.' : 'Could not start sync (check YOUTUBE_API_KEY / DB).', !out.queued);
          await loadState();
        } catch (err) { setStatus(err.message, true); }
      };
      tbody.appendChild(el('tr', {},
        el('td', {}, channelCell(ch)),
        el('td', {}, el('span', { className: 'badge ok', text: ch.discoverySource })),
        el('td', { text: ch.subLanguages.join(', ') }),
        el('td', { text: String(ch.seriesCount) + ' / ' + String(ch.totalEpisodes) }),
        el('td', { text: fmtTime(ch.lastSyncedAt) }),
        el('td', {}, syncBtn)
      ));
    }
    wrap.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Channel' }),
        el('th', { text: 'Source' }),
        el('th', { text: 'Langs' }),
        el('th', { text: 'Series / Eps' }),
        el('th', { text: 'Last Synced' }),
        el('th', { text: 'Action' })
      )),
      tbody
    ));
  }

  async function loadState() {
    try {
      const data = await api('/api/admin/channels');
      const j = data.jobs || {};
      const stats = $('summaryStats');
      stats.textContent = '';
      const items = [
        ['Verified', String(data.verified.length)],
        ['Pending', String(data.candidates.filter((c) => c.discoverySource !== 'rejected').length)],
        ['Running job', j.runningJob || 'idle'],
        ['Queued', String(j.queuedCount || 0)],
        ['Last finished', j.lastFinishedJob ? (j.lastFinishedJob + ' (' + fmtTime(j.lastFinishedAt) + ', exit ' + j.lastExitCode + ')') : 'none'],
      ];
      for (const [label, val] of items) {
        stats.appendChild(el('span', {}, label + ': ', el('strong', { text: val })));
      }
      renderCandidates(data.candidates);
      renderVerified(data.verified);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  $('addChannelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnAddChannel');
    btn.disabled = true;
    try {
      const langs = $('chLangs').value.split(',').map((s) => s.trim()).filter(Boolean);
      setStatus('Resolving channel via YouTube API...');
      const res = await api('/api/admin/channels', 'POST', {
        channel: $('chInput').value.trim(),
        category: $('chCategory').value || undefined,
        regionFocus: $('chRegion').value.trim() || undefined,
        subLanguages: langs.length ? langs : undefined,
        force: $('chForce').checked,
      });
      $('chInput').value = '';
      setStatus('Added ' + res.channel.name + ' (' + res.channel.qualifyingPlaylists + ' playlists)' + (res.syncQueued ? ' — background sync queued!' : '.'));
      await loadState();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  const wireJobBtn = (id, url, label) => {
    $(id).onclick = async () => {
      try {
        const res = await api(url, 'POST', {});
        setStatus(res.queued ? ('Queued: ' + label) : 'Unable to start job (missing YOUTUBE_API_KEY or memory DB).', !res.queued);
        await loadState();
      } catch (err) { setStatus(err.message, true); }
    };
  };

  wireJobBtn('btnIncSync', '/api/admin/sync/incremental', '4h incremental sync');
  wireJobBtn('btnFullSync', '/api/admin/sync/full', 'Full channel sync');
  wireJobBtn('btnLiveSync', '/api/admin/sync/live', 'Live & unlock check');
  wireJobBtn('btnDiscover', '/api/admin/discover', 'Candidate discovery scan');

  $('btnRefresh').onclick = () => loadState();
  $('btnLogout').onclick = async () => {
    await api('/api/admin/logout', 'POST', {}).catch(() => {});
    location.href = '/';
  };

  loadState();
})();
`;

export function registerAdminRoutes(app: Hono, db: DatabaseSync, opts: AdminRoutesOptions = {}) {
  const addChannelFn = opts.addChannel || addOrUpdateSingleChannel;

  app.get('/admin', (c) => {
    stealthHeaders(c);
    const secret = getConfiguredAdminToken();
    if (!secret) return c.text('Not Found', 404);

    const tokenParam = c.req.query('token');
    if (tokenParam) {
      if (timingSafeTextEqual(tokenParam.trim(), secret)) {
        setSessionCookie(c, secret, false);
        return c.redirect('/admin', 302);
      }
      return c.text('Not Found', 404);
    }

    const auth = authenticateRequest(c);
    if (!auth.ok) return c.text('Not Found', 404);
    return c.html(ADMIN_HTML);
  });

  app.get('/admin/app.js', (c) => {
    stealthHeaders(c);
    const auth = authenticateRequest(c);
    if (!auth.ok) return c.text('Not Found', 404);
    return c.text(ADMIN_APP_JS, 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
  });

  app.use('/api/admin/*', async (c, next) => {
    const auth = authenticateRequest(c);
    if (!auth.ok) {
      stealthHeaders(c);
      return c.json({ error: 'Not found' }, 404);
    }
    if (auth.viaCookie && c.req.method !== 'GET' && !verifySameOriginForCookieMutation(c)) {
      stealthHeaders(c);
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
    stealthHeaders(c);
  });

  app.get('/api/admin/channels', (c) => {
    const verifiedRows = db
      .prepare(
        `SELECT c.id, c.youtube_channel_id, c.handle, c.name, c.url, c.avatar_url,
                c.sub_languages, c.category, c.discovery_source, c.playlist_count, c.last_synced_at,
                COUNT(DISTINCT cs.series_id) AS series_count,
                COALESCE(SUM(cs.episode_count), 0) AS total_episodes
         FROM channels c
         LEFT JOIN channel_series cs ON cs.channel_id = c.id
         WHERE c.is_verified = 1
         GROUP BY c.id
         ORDER BY c.last_synced_at DESC, c.name COLLATE NOCASE ASC`
      )
      .all() as unknown as Array<Record<string, unknown>>;

    const candidateRows = db
      .prepare(
        `SELECT id, youtube_channel_id, handle, name, url, avatar_url,
                sub_languages, category, discovery_source, playlist_count, created_at
         FROM channels
         WHERE is_verified = 0
         ORDER BY CASE WHEN discovery_source = 'search_pending' THEN 0 ELSE 1 END, created_at DESC`
      )
      .all() as unknown as Array<Record<string, unknown>>;

    const mapRow = (r: Record<string, unknown>) => {
      let langs: string[] = [];
      try {
        langs = JSON.parse(String(r.sub_languages || '[]'));
      } catch {
        langs = [];
      }
      return {
        id: r.id,
        youtubeChannelId: r.youtube_channel_id,
        handle: r.handle,
        name: r.name,
        url: r.url,
        avatarUrl: r.avatar_url,
        subLanguages: langs,
        category: r.category,
        discoverySource: r.discovery_source,
        playlistCount: r.playlist_count,
        lastSyncedAt: r.last_synced_at ?? null,
        seriesCount: r.series_count ?? 0,
        totalEpisodes: r.total_episodes ?? 0,
      };
    };

    return c.json({
      verified: verifiedRows.map(mapRow),
      candidates: candidateRows.map(mapRow),
      jobs: opts.jobs?.getStatus() ?? null,
    });
  });

  app.post('/api/admin/channels', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      channel?: unknown;
      category?: unknown;
      regionFocus?: unknown;
      subLanguages?: unknown;
      force?: unknown;
      syncNow?: unknown;
    };

    const rawChannel = typeof body.channel === 'string' ? body.channel.trim() : '';
    if (!rawChannel) {
      return c.json({ error: 'channel (URL, @handle, or UC... ID) is required' }, 400);
    }

    const category: ChannelCategory | undefined =
      body.category === 'anime' || body.category === 'donghua' || body.category === 'studio'
        ? body.category
        : undefined;
    const regionFocus = typeof body.regionFocus === 'string' ? body.regionFocus.trim().slice(0, 80) : undefined;
    const subLanguages = Array.isArray(body.subLanguages)
      ? body.subLanguages.filter((l): l is SubLangHint => l === 'en' || l === 'zh-Hant' || l === 'zh-Hans')
      : undefined;

    try {
      const result = await addChannelFn(db, rawChannel, {
        category,
        regionFocus,
        subLanguages: subLanguages && subLanguages.length > 0 ? subLanguages : undefined,
        discoverySource: 'manual',
        force: Boolean(body.force),
      });
      if (!result.ok) {
        return c.json({ error: result.reason || 'Channel verification failed', channel: result }, 422);
      }
      const syncQueued = body.syncNow !== false ? Boolean(opts.jobs?.triggerChannelSync(result.youtubeChannelId)) : false;
      return c.json({ ok: true, channel: result, syncQueued });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed adding channel' }, 400);
    }
  });

  app.post('/api/admin/channels/:id/approve', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const ch = db
      .prepare('SELECT id, youtube_channel_id FROM channels WHERE id = ? LIMIT 1')
      .get(id) as { id: number; youtube_channel_id: string } | undefined;
    if (!ch) return c.json({ error: 'Channel not found' }, 404);

    db.prepare(
      `UPDATE channels
       SET is_verified = 1,
           discovery_source = CASE WHEN discovery_source IN ('search_pending', 'rejected') THEN 'search' ELSE discovery_source END
       WHERE id = ?`
    ).run(id);

    const syncQueued = Boolean(opts.jobs?.triggerChannelSync(ch.youtube_channel_id));
    return c.json({ ok: true, id, syncQueued });
  });

  app.post('/api/admin/channels/:id/reject', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const res = db
      .prepare("UPDATE channels SET is_verified = 0, discovery_source = 'rejected' WHERE id = ?")
      .run(id);
    if (res.changes === 0) return c.json({ error: 'Channel not found' }, 404);
    return c.json({ ok: true, id });
  });

  app.post('/api/admin/channels/:id/sync', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const ch = db
      .prepare('SELECT youtube_channel_id FROM channels WHERE id = ? AND is_verified = 1 LIMIT 1')
      .get(id) as { youtube_channel_id: string } | undefined;
    if (!ch) return c.json({ error: 'Verified channel not found' }, 404);
    const queued = Boolean(opts.jobs?.triggerChannelSync(ch.youtube_channel_id));
    return c.json({ ok: true, queued });
  });

  app.post('/api/admin/sync/incremental', (c) => c.json({ ok: true, queued: Boolean(opts.jobs?.triggerIncrementalSync()) }));
  app.post('/api/admin/sync/full', (c) => c.json({ ok: true, queued: Boolean(opts.jobs?.triggerFullSync()) }));
  app.post('/api/admin/sync/live', (c) => c.json({ ok: true, queued: Boolean(opts.jobs?.triggerLiveCheck()) }));
  app.post('/api/admin/discover', (c) => c.json({ ok: true, queued: Boolean(opts.jobs?.triggerDiscovery()) }));

  app.post('/api/admin/logout', (c) => {
    const secret = getConfiguredAdminToken();
    if (secret) setSessionCookie(c, secret, true);
    return c.json({ ok: true });
  });
}
