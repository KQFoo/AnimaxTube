import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Context, Hono } from 'hono';
import {
  deleteChannelAndCleanup,
  deleteEpisodeAndCleanup,
  deletePlaylistAndCleanup,
  ensureUniqueSlug,
  getYouTubeQuotaStatus,
  refreshSeriesStats,
} from './db/index.ts';
import {
  addOrUpdateSingleChannel,
  upsertChannel,
  type AddChannelOptions,
  type AddChannelResult,
  type ChannelCategory,
  type SubLangHint,
} from './discovery/add-channel.ts';
import {
  classifyAnimeSong,
  cleanSeriesTitle,
  detectChineseScript,
  detectSubLanguage,
  extractEpisodeNumber,
  extractExpiryDate,
  isMembersOnlyText,
  isPromoVideo,
  normalizeSeriesKey,
  type SongType,
} from './ingestion/title-parser.ts';
import {
  fetchChannelsByIds,
  fetchPlaylistItems,
  fetchVideoDetailsMap,
  searchYouTube,
  type YtChannelInfo,
  type YtPlaylistItem,
  type YtSearchResult,
  type YtVideoDetail,
} from './lib/youtube.ts';
import type { JobCoordinator, SyncScope } from './lib/scheduler.ts';

const COOKIE_NAME = 'animaxtube_admin';
const SESSION_TTL_SEC = 7 * 24 * 3600;

export interface AdminRoutesOptions {
  jobs?: JobCoordinator;
  addChannel?: (db: DatabaseSync, rawInput: string, opts: AddChannelOptions) => Promise<AddChannelResult>;
  youtubeSearch?: (query: string, type: 'video' | 'playlist' | 'channel', maxResults?: number) => Promise<YtSearchResult[]>;
  fetchChannels?: (ids: string[]) => Promise<YtChannelInfo[]>;
  fetchPlaylistItems?: (playlistId: string, maxPages?: number) => Promise<YtPlaylistItem[]>;
  fetchVideoDetails?: (videoIds: string[]) => Promise<Map<string, YtVideoDetail>>;
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
      --bg: #0b0e14;
      --surface: #121722;
      --surface-2: #182030;
      --border: #253044;
      --border-soft: #1d2636;
      --text: #eef3f9;
      --muted: #8f9db5;
      --accent: #3ea6ff;
      --accent-hover: #62b8ff;
      --good: #2ecc71;
      --good-bg: rgba(46, 204, 113, 0.12);
      --warn: #f5a623;
      --warn-bg: rgba(245, 166, 35, 0.12);
      --bad: #ff6b6b;
      --bad-bg: rgba(255, 107, 107, 0.12);
      --radius: 12px;
      --shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: radial-gradient(circle at top right, rgba(62, 166, 255, 0.06), transparent 40%), var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Sticky Topbar */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 40;
      background: rgba(11, 14, 20, 0.88);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border-soft);
    }
    .topbar-inner {
      max-width: 1200px;
      margin: 0 auto;
      padding: 12px 20px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .brand { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .brand h1 { font-size: 17px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--muted);
    }
    .live-pill.running { color: var(--accent); border-color: rgba(62, 166, 255, 0.45); background: rgba(62, 166, 255, 0.1); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); flex-shrink: 0; }
    .live-pill.running .dot { background: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }

    main { max-width: 1200px; margin: 0 auto; padding: 20px 20px 64px; }

    /* Cards & Headers */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      margin-bottom: 18px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
    }
    .card-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .card-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      font-weight: 600;
      margin: 0;
    }
    .count-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 20px;
      padding: 0 7px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .count-pill.warn { color: var(--warn); border-color: rgba(245, 166, 35, 0.4); background: var(--warn-bg); }

    /* KPI Summary Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); font-weight: 600; }
    .kpi-val { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
    .kpi-val.sm { font-size: 14px; font-weight: 600; line-height: 1.35; }
    .kpi-sub { font-size: 12px; color: var(--muted); }

    /* Buttons & Inputs */
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    button, .btn-link {
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 7px 13px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.15s, border-color 0.15s, transform 0.05s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
    }
    button:hover:not(:disabled), .btn-link:hover { border-color: var(--accent); background: #1f2a3f; text-decoration: none; }
    button:active:not(:disabled), .btn-link:active { transform: translateY(1px); }
    button.primary { background: var(--accent); color: #06101c; border-color: var(--accent); font-weight: 600; }
    button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
    button.danger { background: transparent; border-color: rgba(255, 107, 107, 0.35); color: var(--bad); }
    button.danger:hover:not(:disabled) { background: var(--bad-bg); border-color: var(--bad); }
    button.ghost { background: transparent; border-color: transparent; color: var(--muted); }
    button.ghost:hover:not(:disabled) { background: var(--surface-2); color: var(--text); border-color: var(--border); }
    button.sm, .btn-link.sm { padding: 5px 10px; font-size: 12px; border-radius: 6px; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }

    input, select {
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 11px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(62, 166, 255, 0.18); }

    /* Sync Control Center */
    .sync-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .schedule-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-soft);
      font-size: 12px;
      color: var(--muted);
    }
    .sched-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--bg);
      border: 1px solid var(--border-soft);
      font-variant-numeric: tabular-nums;
    }
    .sched-chip strong { color: var(--text); font-weight: 600; }

    .queued-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .queued-item {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px 6px 12px;
      border: 1px solid rgba(62, 166, 255, 0.35);
      border-radius: 8px;
      background: rgba(62, 166, 255, 0.08);
      font-size: 12px;
    }

    /* Add Channel Form */
    .add-primary-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; margin-bottom: 12px; }
    .add-primary-row input { flex: 1; min-width: 260px; font-size: 14px; padding: 10px 13px; }
    .add-meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; align-items: end; }
    .field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
    .toggle-group { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .toggle-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 6px 11px;
      border-radius: 8px;
      background: var(--bg);
      border: 1px solid var(--border);
      font-size: 12px;
      color: var(--text);
      cursor: pointer;
      user-select: none;
    }
    .toggle-pill:hover { border-color: var(--accent); }
    .toggle-pill input { margin: 0; accent-color: var(--accent); cursor: pointer; }

    /* Tables */
    .table-wrap { overflow-x: auto; margin: 0 -4px; padding: 0 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
    th {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    tbody tr { transition: background 0.12s; }
    tbody tr:hover { background: rgba(255, 255, 255, 0.025); }
    tbody tr:last-child td { border-bottom: none; }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }

    .ch-cell { display: flex; align-items: center; gap: 10px; min-width: 200px; }
    .ch-cell img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--bg); border: 1px solid var(--border); flex-shrink: 0; }
    .ch-name { font-weight: 600; color: var(--text); }
    .ch-sub { font-size: 11px; color: var(--muted); }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--border);
      color: var(--muted);
      white-space: nowrap;
    }
    .badge.pending { color: var(--warn); border-color: rgba(245, 166, 35, 0.4); background: var(--warn-bg); }
    .badge.rejected { color: var(--bad); border-color: rgba(255, 107, 107, 0.4); background: var(--bad-bg); }
    .badge.ok { color: var(--good); border-color: rgba(46, 204, 113, 0.35); background: var(--good-bg); }

    .sync-opts { display: flex; gap: 6px; flex-wrap: wrap; }
    .mini-toggle {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
      font-size: 11px;
      color: var(--text);
      cursor: pointer;
      user-select: none;
    }
    .mini-toggle input { margin: 0; accent-color: var(--accent); cursor: pointer; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .muted { color: var(--muted); font-size: 12px; }
    .empty-state { padding: 18px 8px; text-align: center; color: var(--muted); font-size: 13px; }
    .search-box { min-width: 220px; width: 260px; max-width: 100%; }

    /* Drawer Modal for Channel Content Manager */
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      z-index: 80;
      background: rgba(5, 8, 13, 0.72);
      backdrop-filter: blur(4px);
      display: none;
      justify-content: flex-end;
    }
    .drawer-backdrop.open { display: flex; }
    .drawer {
      width: min(860px, 100vw);
      height: 100vh;
      background: var(--surface);
      border-left: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .drawer-head {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      background: var(--surface-2);
    }
    .drawer-body { padding: 16px 20px 28px; overflow-y: auto; flex: 1; }
    .cm-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
    .cm-bar input { flex: 1; min-width: 200px; }
    .segmented { display: inline-flex; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 2px; gap: 2px; }
    .segmented button { border: none; background: transparent; padding: 5px 12px; border-radius: 6px; font-size: 12px; color: var(--muted); }
    .segmented button.active { background: var(--accent); color: #06101c; font-weight: 600; }
    .filter-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: rgba(62, 166, 255, 0.14);
      border: 1px solid rgba(62, 166, 255, 0.4);
      color: var(--accent);
      margin-bottom: 10px;
    }
    .filter-pill button { padding: 0 4px; border: none; background: transparent; color: var(--accent); font-weight: 700; }

    /* Toast Notifications */
    .toast-stack {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: min(420px, calc(100vw - 36px));
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 13px;
      color: var(--text);
      box-shadow: var(--shadow);
      cursor: pointer;
    }
    .toast.error { border-left-color: var(--bad); color: #ffd4d4; }
    .toast.ok { border-left-color: var(--good); }
    .status-line { font-size: 12px; color: var(--muted); margin-top: 8px; min-height: 16px; }
    .status-line.error { color: var(--bad); }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <h1>AnimaxTube Private Channel Admin</h1>
        <span id="liveJobPill" class="live-pill"><span class="dot"></span><span id="liveJobText">Loading...</span></span>
      </div>
      <div class="toolbar">
        <a href="/" target="_blank" rel="noopener noreferrer" class="btn-link sm">Open Homepage ↗</a>
        <button id="btnRefresh" class="sm">Refresh</button>
        <button id="btnLogout" class="sm danger">Sign Out</button>
      </div>
    </div>
  </header>

  <main>
    <section id="summaryStats" class="kpi-grid"></section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Sync &amp; Discovery Controls</h2>
      </div>
      <div class="sync-bar">
        <select id="globalSyncScope" title="Sync scope for global incremental/full runs">
          <option value="">Scope: Channel defaults</option>
          <option value="both">Scope: Playlists + Videos</option>
          <option value="playlists">Scope: Playlists only</option>
          <option value="videos">Scope: Channel videos only</option>
        </select>
        <button id="btnIncSync" class="primary">Run 4h Incremental Sync</button>
        <button id="btnFullSync">Run Full Sync</button>
        <button id="btnSongSync">Sync Songs (OP/ED/OST)</button>
        <button id="btnLiveSync">Check Live</button>
        <button id="btnDiscover">Scan Candidates (~600 quota)</button>
      </div>
      <div id="scheduleCountdowns" class="schedule-strip"></div>
      <div id="queuedJobsWrap" class="queued-list"></div>
      <div id="actionStatus" class="status-line"></div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Add &amp; Sync Official YouTube Channel</h2>
      </div>
      <form id="addChannelForm">
        <div class="add-primary-row">
          <input id="chInput" type="text" placeholder="Paste YouTube Channel URL, @handle, or UC... ID (e.g. https://www.youtube.com/@MuseAsia)" required />
          <button id="btnAddChannel" type="submit" class="primary">Add &amp; Sync Channel</button>
        </div>
        <div class="add-meta-grid">
          <label class="field">
            Category
            <select id="chCategory">
              <option value="">Auto-detect</option>
              <option value="anime">anime</option>
              <option value="donghua">donghua</option>
              <option value="studio">studio</option>
            </select>
          </label>
          <label class="field">
            Region Focus (optional)
            <input id="chRegion" type="text" placeholder="Asia / Global" />
          </label>
          <label class="field">
            Sub Languages (comma separated)
            <input id="chLangs" type="text" placeholder="en,zh-Hant" />
          </label>
        </div>
        <div class="toggle-group">
          <label class="toggle-pill"><input id="chSyncPlaylists" type="checkbox" checked /> Sync playlists</label>
          <label class="toggle-pill"><input id="chSyncVideos" type="checkbox" checked /> Sync channel videos</label>
          <label class="toggle-pill"><input id="chForce" type="checkbox" /> Force add (&lt;2 playlists)</label>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Candidate Review Queue <span id="pendingCount" class="count-pill">0</span></h2>
      </div>
      <div id="candidatesWrap" class="table-wrap">Loading...</div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">Verified Channels <span id="verifiedCount" class="count-pill">0</span></h2>
        <input id="verifiedSearch" class="search-box" type="search" placeholder="Filter channels by name, @handle, lang..." />
      </div>
      <div id="verifiedWrap" class="table-wrap">Loading...</div>
    </section>
  </main>

  <div id="contentManagerBackdrop" class="drawer-backdrop" role="dialog" aria-modal="true" aria-labelledby="cmChannelName">
    <div id="contentManagerCard" class="drawer">
      <div class="drawer-head">
        <div id="cmChannelHeader" class="ch-cell">
          <span id="cmChannelName" style="font-weight:700;font-size:15px;">Channel Content</span>
        </div>
        <button id="btnCloseCm" class="sm">Close (Esc)</button>
      </div>
      <div class="drawer-body">
        <div class="cm-bar">
          <div class="segmented">
            <button id="cmTabPlaylists" class="tab-btn active">Playlists</button>
            <button id="cmTabVideos" class="tab-btn">Videos</button>
          </div>
          <input id="cmSearch" type="search" placeholder="Search by title or YouTube ID..." />
          <button id="cmBtnSearch" class="sm">Filter</button>
        </div>
        <div id="cmActiveFilterWrap" style="display:none;">
          <span class="filter-pill">
            <span id="cmActiveFilterLabel"></span>
            <button id="cmClearFilter" type="button" title="Show all channel videos">&times;</button>
          </span>
        </div>
        <div id="cmMeta" class="muted" style="margin-bottom:10px;"></div>
        <div id="cmTableWrap" class="table-wrap"></div>
      </div>
    </div>
  </div>

  <div id="toastStack" class="toast-stack" aria-live="polite"></div>
  <script src="/admin/app.js"></script>
</body>
</html>`;

const ADMIN_APP_JS = `(() => {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('actionStatus');
  let latestJobs = null;
  let latestQuota = null;
  let allVerified = [];
  let pollTimer = null;
  let cmSearchTimer = null;
  let cmState = { channel: null, tab: 'playlists', channelSeriesId: null, playlistTitle: null };

  function showToast(msg, kind = 'info') {
    if (!msg) return;
    const stack = $('toastStack');
    const toast = el('div', { className: 'toast' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : ''), text: msg });
    toast.onclick = () => toast.remove();
    stack.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4500);
  }

  function setStatus(msg, isError = false, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = isError ? 'status-line error' : 'status-line';
    if (msg) showToast(msg, isError ? 'error' : (kind || 'ok'));
  }

  function fmtTime(unixSec) {
    if (!unixSec) return 'never';
    const d = new Date(unixSec * 1000);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtCountdown(targetUnix) {
    if (!targetUnix) return 'off';
    const diff = Math.max(0, targetUnix - Math.floor(Date.now() / 1000));
    if (diff === 0) return 'due now';
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    return m + 'm ' + s + 's';
  }

  function renderJobHeader(jobs, quota) {
    latestJobs = jobs || null;
    if (quota !== undefined) latestQuota = quota;
    const j = jobs || {};
    const q = latestQuota;
    const counts = window.__adminCounts || { verified: '-', pending: '-', episodes: 0 };

    const pill = $('liveJobPill');
    const pillText = $('liveJobText');
    if (j.runningJob) {
      pill.className = 'live-pill running';
      pillText.textContent = 'Running: ' + j.runningJob;
    } else if ((j.queuedCount || 0) > 0) {
      pill.className = 'live-pill running';
      pillText.textContent = String(j.queuedCount) + ' job(s) queued';
    } else {
      pill.className = 'live-pill';
      pillText.textContent = 'Worker idle';
    }

    const stats = $('summaryStats');
    stats.textContent = '';

    const kpiCard = (label, val, sub, smallVal = false, valColor = '') =>
      el('div', { className: 'kpi' },
        el('div', { className: 'kpi-label', text: label }),
        el('div', { className: smallVal ? 'kpi-val sm' : 'kpi-val', style: valColor ? ('color:' + valColor) : undefined, text: val }),
        sub ? el('div', { className: 'kpi-sub', text: sub }) : null
      );

    stats.appendChild(kpiCard('Verified Channels', String(counts.verified), counts.episodes ? (counts.episodes.toLocaleString() + ' synced videos') : 'Active catalog'));
    stats.appendChild(kpiCard('Pending Review', String(counts.pending), counts.pending > 0 ? 'Awaiting approval' : 'Queue clear'));
    if (q) {
      const pct = q.dailyLimit > 0 ? q.remaining / q.dailyLimit : 0;
      const qColor = q.dailyLimit === 0 ? 'var(--muted)' : pct < 0.1 ? 'var(--bad)' : pct < 0.3 ? 'var(--warn)' : 'var(--good)';
      const qVal = q.dailyLimit > 0 ? (q.remaining.toLocaleString() + ' / ' + q.dailyLimit.toLocaleString()) : 'No API key';
      const qSub = q.dailyLimit > 0
        ? ('Used: ' + q.usedToday.toLocaleString() + ' · ' + q.keyCount + ' key' + (q.keyCount === 1 ? '' : 's') + ' · Resets in ' + fmtCountdown(q.resetAt))
        : 'Set YOUTUBE_API_KEY to track quota';
      stats.appendChild(kpiCard('YT Quota Left', qVal, qSub, false, qColor));
    }
    stats.appendChild(kpiCard(
      'Background Worker',
      j.runningJob || 'Idle',
      'Queued: ' + String(j.queuedCount || 0),
      true
    ));
    stats.appendChild(kpiCard(
      'Last Finished Job',
      j.lastFinishedJob || 'None yet',
      j.lastFinishedJob ? (fmtTime(j.lastFinishedAt) + ' · exit ' + j.lastExitCode) : 'No completed runs',
      true
    ));

    renderCountdowns();
    renderQueuedJobs(j);
    schedulePollIfActive(j);
  }

  function renderQueuedJobs(j) {
    const wrap = $('queuedJobsWrap');
    wrap.textContent = '';
    const count = (j && j.queuedCount) || 0;
    if (count <= 0) return;

    const jobs = Array.isArray(j.queuedJobs) && j.queuedJobs.length > 0
      ? j.queuedJobs
      : [{ id: '', label: 'Next queued job' }];

    for (const item of jobs) {
      const runBtn = el('button', { className: 'primary sm', text: 'Run Now' });
      runBtn.onclick = async () => {
        runBtn.disabled = true;
        try {
          const payload = item.id ? { jobId: item.id } : {};
          const res = await api('/api/admin/jobs/run-now', 'POST', payload);
          const msg = res.preemptedRunningJob
            ? 'Running "' + res.startedOrPromoted + '" now (stopped "' + res.preemptedRunningJob + '").'
            : 'Started "' + res.startedOrPromoted + '" now.';
          setStatus(msg);
          if (res.jobs) renderJobHeader(res.jobs, res.quota);
          else await loadState();
        } catch (err) {
          setStatus(err.message, true);
        } finally {
          runBtn.disabled = false;
        }
      };

      const removeBtn = item.id ? el('button', { className: 'danger sm', text: 'Remove' }) : null;
      if (removeBtn) {
        removeBtn.onclick = async () => {
          removeBtn.disabled = true;
          try {
            const res = await api('/api/admin/jobs/remove', 'POST', { jobId: item.id });
            setStatus('Removed "' + (res.removedLabel || item.label) + '" from queue.');
            if (res.jobs) renderJobHeader(res.jobs, res.quota);
            else await loadState();
          } catch (err) {
            setStatus(err.message, true);
          } finally {
            removeBtn.disabled = false;
          }
        };
      }

      wrap.appendChild(el('div', { className: 'queued-item' },
        el('span', { text: 'Queued: ' + item.label }),
        runBtn,
        removeBtn
      ));
    }
  }

  function renderCountdowns() {
    const wrap = $('scheduleCountdowns');
    wrap.textContent = '';
    if (!latestJobs) return;
    if (!latestJobs.autoSyncEnabled) {
      wrap.appendChild(el('span', { text: 'Auto-sync schedules disabled (set ENABLE_AUTO_SYNC=true to enable background timers).' }));
      return;
    }
    const iv = latestJobs.intervals || {};
    const next = latestJobs.nextRunAt || {};
    const entries = [
      ['Live (' + (iv.liveMinutes || 30) + 'm)', fmtCountdown(next.liveAt)],
      ['Incremental (' + (iv.incrementalHours || 4) + 'h)', fmtCountdown(next.incrementalAt)],
      ['Full sweep (' + (iv.channelHours || 24) + 'h)', fmtCountdown(next.fullSyncAt)],
      ['Discovery (' + (iv.discoveryHours ? iv.discoveryHours + 'h' : 'off') + ')', iv.discoveryHours ? fmtCountdown(next.discoveryAt) : 'off'],
    ];
    for (const [label, val] of entries) {
      wrap.appendChild(el('span', { className: 'sched-chip' }, label + ': ', el('strong', { text: val })));
    }
  }

  function schedulePollIfActive(j) {
    const active = Boolean(j && (j.runningJob || (j.queuedCount || 0) > 0));
    if (active && !pollTimer) {
      pollTimer = setInterval(async () => {
        try {
          const prevActive = Boolean(latestJobs && (latestJobs.runningJob || (latestJobs.queuedCount || 0) > 0));
          const res = await api('/api/admin/jobs');
          renderJobHeader(res.jobs, res.quota);
          const stillActive = Boolean(res.jobs && (res.jobs.runningJob || (res.jobs.queuedCount || 0) > 0));
          if (prevActive && !stillActive) {
            await loadState();
          }
        } catch {
          // ignore transient poll failures
        }
      }, 4000);
    } else if (!active && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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
    const link = el('a', { className: 'ch-name', href: ch.url, target: '_blank', rel: 'noopener noreferrer', text: ch.name });
    return el('div', { className: 'ch-cell' }, img, el('div', {}, link, el('div', { className: 'ch-sub', text: ch.handle || ch.youtubeChannelId })));
  }

  function renderCandidates(list) {
    const wrap = $('candidatesWrap');
    const pendingTotal = list.filter((c) => c.discoverySource !== 'rejected').length;
    const pill = $('pendingCount');
    pill.textContent = String(pendingTotal);
    pill.className = pendingTotal > 0 ? 'count-pill warn' : 'count-pill';
    wrap.textContent = '';
    if (!list.length) {
      wrap.appendChild(el('div', { className: 'empty-state', text: 'No pending or rejected candidates.' }));
      return;
    }
    const tbody = el('tbody');
    for (const ch of list) {
      const badgeCls = ch.discoverySource === 'rejected' ? 'badge rejected' : 'badge pending';
      const approveBtn = el('button', { className: 'primary sm', text: 'Approve & Sync' });
      approveBtn.onclick = async () => {
        try {
          setStatus('Approving ' + ch.name + '...', false, 'info');
          await api('/api/admin/channels/' + ch.id + '/approve', 'POST', {});
          setStatus('Approved ' + ch.name + ' and queued sync.');
          await loadState();
        } catch (err) { setStatus(err.message, true); }
      };
      const rejectBtn = ch.discoverySource === 'rejected'
        ? null
        : el('button', { className: 'sm danger', text: 'Reject' });
      if (rejectBtn) {
        rejectBtn.onclick = async () => {
          try {
            await api('/api/admin/channels/' + ch.id + '/reject', 'POST', {});
            setStatus('Rejected ' + ch.name + '.');
            await loadState();
          } catch (err) { setStatus(err.message, true); }
        };
      }
      const removeBtn = el('button', { className: 'sm danger', text: 'Remove' });
      removeBtn.onclick = async () => {
        if (!confirm('Remove candidate "' + ch.name + '" from the database?')) return;
        try {
          await api('/api/admin/channels/' + ch.id, 'DELETE');
          setStatus('Removed ' + ch.name + '.');
          await loadState();
        } catch (err) { setStatus(err.message, true); }
      };
      tbody.appendChild(el('tr', {},
        el('td', {}, channelCell(ch)),
        el('td', {}, el('span', { className: badgeCls, text: ch.discoverySource })),
        el('td', { text: ch.subLanguages.join(', ') }),
        el('td', { className: 'num', text: String(ch.playlistCount) }),
        el('td', {}, el('div', { className: 'actions' }, approveBtn, rejectBtn, removeBtn))
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
    allVerified = list;
    const q = ($('verifiedSearch').value || '').trim().toLowerCase();
    const filtered = q
      ? list.filter((ch) =>
          (ch.name || '').toLowerCase().includes(q) ||
          (ch.handle || '').toLowerCase().includes(q) ||
          (ch.youtubeChannelId || '').toLowerCase().includes(q) ||
          (ch.discoverySource || '').toLowerCase().includes(q) ||
          (ch.subLanguages || []).join(' ').toLowerCase().includes(q)
        )
      : list;

    $('verifiedCount').textContent = q ? (filtered.length + ' / ' + list.length) : String(list.length);
    const wrap = $('verifiedWrap');
    wrap.textContent = '';

    if (!filtered.length) {
      wrap.appendChild(el('div', { className: 'empty-state', text: q ? 'No channels match "' + q + '".' : 'No verified channels yet.' }));
      return;
    }

    const tbody = el('tbody');
    for (const ch of filtered) {
      const plCheck = el('input', { type: 'checkbox' });
      plCheck.checked = ch.syncPlaylists !== false;
      const vidCheck = el('input', { type: 'checkbox' });
      vidCheck.checked = ch.syncVideos !== false;

      const saveSyncOpts = async () => {
        plCheck.disabled = true;
        vidCheck.disabled = true;
        try {
          await api('/api/admin/channels/' + ch.id + '/sync-options', 'PATCH', {
            syncPlaylists: plCheck.checked,
            syncVideos: vidCheck.checked,
          });
          ch.syncPlaylists = plCheck.checked;
          ch.syncVideos = vidCheck.checked;
          const parts = [plCheck.checked ? 'playlists' : null, vidCheck.checked ? 'channel videos' : null].filter(Boolean);
          setStatus('Updated sync options for ' + ch.name + ': ' + (parts.length ? parts.join(' + ') : 'paused') + '.');
        } catch (err) {
          plCheck.checked = ch.syncPlaylists !== false;
          vidCheck.checked = ch.syncVideos !== false;
          setStatus(err.message, true);
        } finally {
          plCheck.disabled = false;
          vidCheck.disabled = false;
        }
      };
      plCheck.onchange = saveSyncOpts;
      vidCheck.onchange = saveSyncOpts;

      const syncOptsCell = el('div', { className: 'sync-opts' },
        el('label', { className: 'mini-toggle' }, plCheck, 'Playlists'),
        el('label', { className: 'mini-toggle' }, vidCheck, 'Videos')
      );

      const syncBtn = el('button', { className: 'sm', text: 'Sync' });
      syncBtn.onclick = async () => {
        try {
          const scope = plCheck.checked && vidCheck.checked ? 'both' : plCheck.checked ? 'playlists' : vidCheck.checked ? 'videos' : null;
          if (!scope) {
            setStatus('Enable Playlists and/or Videos for ' + ch.name + ' before syncing.', true);
            return;
          }
          const out = await api('/api/admin/channels/' + ch.id + '/sync', 'POST', { scope });
          setStatus(out.queued ? 'Queued ' + scope + ' sync for ' + ch.name + '.' : 'Could not start sync (check YOUTUBE_API_KEY / DB).', !out.queued);
          await loadState();
        } catch (err) { setStatus(err.message, true); }
      };

      const manageBtn = el('button', { className: 'sm', text: 'Manage' });
      manageBtn.onclick = () => openContentManager(ch);

      const removeBtn = el('button', { className: 'sm danger', text: 'Remove' });
      removeBtn.onclick = async () => {
        const msg = 'Remove "' + ch.name + '" and all ' + ch.totalEpisodes + ' of its synced videos? This cannot be undone.';
        if (!confirm(msg)) return;
        try {
          const out = await api('/api/admin/channels/' + ch.id, 'DELETE');
          const d = out.deleted || {};
          if (cmState.channel && cmState.channel.id === ch.id) {
            closeContentManager();
          }
          setStatus('Removed ' + ch.name + ' (' + (d.deletedEpisodes || 0) + ' videos removed, ' + (d.removedSeriesCount || 0) + ' orphaned series cleaned up).');
          await loadState();
        } catch (err) { setStatus(err.message, true); }
      };

      tbody.appendChild(el('tr', {},
        el('td', {}, channelCell(ch)),
        el('td', {}, el('span', { className: 'badge ok', text: ch.discoverySource })),
        el('td', { text: ch.subLanguages.join(', ') }),
        el('td', { className: 'num', text: String(ch.seriesCount) + ' / ' + String(ch.totalEpisodes) }),
        el('td', {}, syncOptsCell),
        el('td', { className: 'num muted', text: fmtTime(ch.lastSyncedAt) }),
        el('td', {}, el('div', { className: 'actions' }, manageBtn, syncBtn, removeBtn))
      ));
    }
    wrap.appendChild(el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Channel' }),
        el('th', { text: 'Source' }),
        el('th', { text: 'Langs' }),
        el('th', { text: 'Series / Videos' }),
        el('th', { text: 'Sync Options' }),
        el('th', { text: 'Last Synced' }),
        el('th', { text: 'Actions' })
      )),
      tbody
    ));
  }

  async function loadState() {
    try {
      const data = await api('/api/admin/channels');
      const totalEps = data.verified.reduce((sum, c) => sum + (Number(c.totalEpisodes) || 0), 0);
      window.__adminCounts = {
        verified: data.verified.length,
        pending: data.candidates.filter((c) => c.discoverySource !== 'rejected').length,
        episodes: totalEps,
      };
      renderJobHeader(data.jobs, data.quota);
      renderCandidates(data.candidates);
      renderVerified(data.verified);
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  $('verifiedSearch').addEventListener('input', () => renderVerified(allVerified));

  $('addChannelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('btnAddChannel');
    btn.disabled = true;
    try {
      const langs = $('chLangs').value.split(',').map((s) => s.trim()).filter(Boolean);
      setStatus('Resolving channel via YouTube API...', false, 'info');
      const res = await api('/api/admin/channels', 'POST', {
        channel: $('chInput').value.trim(),
        category: $('chCategory').value || undefined,
        regionFocus: $('chRegion').value.trim() || undefined,
        subLanguages: langs.length ? langs : undefined,
        force: $('chForce').checked,
        syncPlaylists: $('chSyncPlaylists').checked,
        syncVideos: $('chSyncVideos').checked,
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

  const wireJobBtn = (id, url, label, withScope = false) => {
    $(id).onclick = async () => {
      try {
        const scope = withScope ? ($('globalSyncScope').value || undefined) : undefined;
        const res = await api(url, 'POST', scope ? { scope } : {});
        const suffix = scope ? ' (' + scope + ')' : '';
        setStatus(res.queued ? ('Queued: ' + label + suffix) : 'Unable to start job (missing YOUTUBE_API_KEY or memory DB).', !res.queued);
        await loadState();
      } catch (err) { setStatus(err.message, true); }
    };
  };

  wireJobBtn('btnIncSync', '/api/admin/sync/incremental', '4h incremental sync', true);
  wireJobBtn('btnFullSync', '/api/admin/sync/full', 'Full channel sync', true);
  wireJobBtn('btnSongSync', '/api/admin/sync/songs', 'Anime songs sync (OP/ED/OST)');
  wireJobBtn('btnLiveSync', '/api/admin/sync/live', 'Live & unlock check');
  wireJobBtn('btnDiscover', '/api/admin/discover', 'Candidate discovery scan');

  function closeContentManager() {
    cmState = { channel: null, tab: 'playlists', channelSeriesId: null, playlistTitle: null };
    $('contentManagerBackdrop').className = 'drawer-backdrop';
    $('cmTableWrap').textContent = '';
  }

  async function openContentManager(ch) {
    cmState = { channel: ch, tab: 'playlists', channelSeriesId: null, playlistTitle: null };
    const head = $('cmChannelHeader');
    head.textContent = '';
    if (ch.avatarUrl) head.appendChild(el('img', { src: ch.avatarUrl, alt: '' }));
    head.appendChild(el('div', {},
      el('div', { id: 'cmChannelName', style: 'font-weight:700;font-size:15px;', text: ch.name }),
      el('div', { className: 'ch-sub', text: ch.handle || ch.youtubeChannelId })
    ));
    $('cmSearch').value = '';
    $('contentManagerBackdrop').className = 'drawer-backdrop open';
    await loadContentManager();
  }

  async function loadContentManager() {
    if (!cmState.channel) return;
    const ch = cmState.channel;
    const q = $('cmSearch').value.trim();
    $('cmTabPlaylists').className = cmState.tab === 'playlists' ? 'tab-btn active' : 'tab-btn';
    $('cmTabVideos').className = cmState.tab === 'videos' ? 'tab-btn active' : 'tab-btn';
    const hasFilter = cmState.tab === 'videos' && Boolean(cmState.channelSeriesId);
    $('cmActiveFilterWrap').style.display = hasFilter ? '' : 'none';
    if (hasFilter) {
      $('cmActiveFilterLabel').textContent = 'Playlist: ' + (cmState.playlistTitle || ('#' + cmState.channelSeriesId));
    }
    const wrap = $('cmTableWrap');
    const meta = $('cmMeta');
    wrap.textContent = 'Loading...';
    meta.textContent = '';

    try {
      if (cmState.tab === 'playlists') {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        const qs = params.toString() ? ('?' + params.toString()) : '';
        const data = await api('/api/admin/channels/' + ch.id + '/playlists' + qs);
        meta.textContent = 'Showing ' + data.playlists.length + ' playlist(s) for ' + ch.name + '.';
        wrap.textContent = '';
        if (!data.playlists.length) {
          wrap.appendChild(el('div', { className: 'empty-state', text: 'No playlists found.' }));
          return;
        }
        const tbody = el('tbody');
        for (const pl of data.playlists) {
          const viewVideosBtn = el('button', { className: 'sm', text: 'Videos (' + pl.episodeCount + ')' });
          viewVideosBtn.onclick = async () => {
            cmState.tab = 'videos';
            cmState.channelSeriesId = pl.id;
            cmState.playlistTitle = pl.playlistTitle;
            await loadContentManager();
          };
          const rmBtn = el('button', { className: 'sm danger', text: 'Remove' });
          rmBtn.onclick = async () => {
            if (!confirm('Remove playlist "' + pl.playlistTitle + '" and all ' + pl.episodeCount + ' of its videos from ' + ch.name + '?')) return;
            try {
              const out = await api('/api/admin/channels/' + ch.id + '/playlists/' + pl.id, 'DELETE');
              const d = out.deleted || {};
              setStatus('Removed playlist "' + pl.playlistTitle + '" (' + (d.deletedEpisodes || 0) + ' videos removed' + (d.removedSeries ? ', orphaned series cleaned up' : '') + ').');
              await loadContentManager();
              await loadState();
            } catch (err) { setStatus(err.message, true); }
          };
          tbody.appendChild(el('tr', {},
            el('td', {},
              el('a', { href: pl.playlistUrl, target: '_blank', rel: 'noopener noreferrer', text: pl.playlistTitle }),
              el('div', { className: 'ch-sub', text: pl.playlistId })
            ),
            el('td', { text: pl.seriesTitle || '-' }),
            el('td', { text: pl.subLanguage }),
            el('td', { className: 'num', text: String(pl.episodeCount) }),
            el('td', {}, el('div', { className: 'actions' }, viewVideosBtn, rmBtn))
          ));
        }
        wrap.appendChild(el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { text: 'Playlist' }),
            el('th', { text: 'Series' }),
            el('th', { text: 'Lang' }),
            el('th', { text: 'Videos' }),
            el('th', { text: 'Actions' })
          )),
          tbody
        ));
      } else {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (cmState.channelSeriesId) params.set('channelSeriesId', String(cmState.channelSeriesId));
        const qs = params.toString() ? ('?' + params.toString()) : '';
        const data = await api('/api/admin/channels/' + ch.id + '/videos' + qs);
        const scopeText = cmState.playlistTitle ? (' in "' + cmState.playlistTitle + '"') : '';
        meta.textContent = 'Showing ' + data.videos.length + ' of ' + data.total + ' video(s)' + scopeText + '.';
        wrap.textContent = '';
        if (!data.videos.length) {
          wrap.appendChild(el('div', { className: 'empty-state', text: 'No videos found.' }));
          return;
        }
        const tbody = el('tbody');
        for (const v of data.videos) {
          const rmBtn = el('button', { className: 'sm danger', text: 'Remove' });
          rmBtn.onclick = async () => {
            if (!confirm('Remove video "' + v.title + '" (' + v.youtubeVideoId + ') from ' + ch.name + '?')) return;
            try {
              const out = await api('/api/admin/channels/' + ch.id + '/videos/' + v.id, 'DELETE');
              const d = out.deleted || {};
              if (d.removedPlaylist && cmState.channelSeriesId === v.channelSeriesId) {
                cmState.channelSeriesId = null;
                cmState.playlistTitle = null;
              }
              setStatus('Removed video "' + v.title + '"' + (d.removedPlaylist ? ' (empty playlist removed)' : '') + (d.removedSeries ? ' (orphaned series removed)' : '') + '.');
              await loadContentManager();
              await loadState();
            } catch (err) { setStatus(err.message, true); }
          };
          tbody.appendChild(el('tr', {},
            el('td', { className: 'num', text: v.episodeNumber !== null && v.episodeNumber !== undefined ? String(v.episodeNumber) : '-' }),
            el('td', {},
              el('a', { href: 'https://www.youtube.com/watch?v=' + encodeURIComponent(v.youtubeVideoId), target: '_blank', rel: 'noopener noreferrer', text: v.title }),
              el('div', { className: 'ch-sub', text: v.youtubeVideoId })
            ),
            el('td', { text: v.playlistTitle || '-' }),
            el('td', { text: v.subLanguage }),
            el('td', {}, rmBtn)
          ));
        }
        wrap.appendChild(el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { text: 'Ep' }),
            el('th', { text: 'Video' }),
            el('th', { text: 'Playlist' }),
            el('th', { text: 'Lang' }),
            el('th', { text: 'Action' })
          )),
          tbody
        ));
      }
    } catch (err) {
      wrap.textContent = '';
      setStatus(err.message, true);
    }
  }

  $('btnCloseCm').onclick = () => closeContentManager();
  $('contentManagerBackdrop').addEventListener('click', (e) => {
    if (e.target === $('contentManagerBackdrop')) closeContentManager();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && cmState.channel) closeContentManager();
  });
  $('cmTabPlaylists').onclick = async () => {
    cmState.tab = 'playlists';
    await loadContentManager();
  };
  $('cmTabVideos').onclick = async () => {
    cmState.tab = 'videos';
    await loadContentManager();
  };
  $('cmClearFilter').onclick = async () => {
    cmState.channelSeriesId = null;
    cmState.playlistTitle = null;
    await loadContentManager();
  };
  $('cmBtnSearch').onclick = () => loadContentManager();
  $('cmSearch').addEventListener('input', () => {
    clearTimeout(cmSearchTimer);
    cmSearchTimer = setTimeout(() => loadContentManager(), 250);
  });
  $('cmSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(cmSearchTimer);
      loadContentManager();
    }
  });

  $('btnRefresh').onclick = () => loadState();
  $('btnLogout').onclick = async () => {
    await api('/api/admin/logout', 'POST', {}).catch(() => {});
    location.href = '/';
  };

  setInterval(renderCountdowns, 1000);
  loadState();
})();
`;

function parseSyncScope(raw: unknown): SyncScope | undefined {
  return raw === 'both' || raw === 'playlists' || raw === 'videos' ? raw : undefined;
}

function syncScopeFromFlags(syncPlaylists: boolean, syncVideos: boolean): SyncScope | null {
  if (syncPlaylists && syncVideos) return 'both';
  if (syncPlaylists) return 'playlists';
  if (syncVideos) return 'videos';
  return null;
}

export function registerAdminRoutes(app: Hono, db: DatabaseSync, opts: AdminRoutesOptions = {}) {
  const addChannelFn = opts.addChannel || addOrUpdateSingleChannel;
  const ytSearchFn = opts.youtubeSearch || searchYouTube;
  const ytFetchChannelsFn = opts.fetchChannels || fetchChannelsByIds;
  const ytFetchPlaylistItemsFn = opts.fetchPlaylistItems || fetchPlaylistItems;
  const ytFetchVideoDetailsFn = opts.fetchVideoDetails || fetchVideoDetailsMap;

  const ensureChannelInDb = async (
    youtubeChannelId: string,
    fallbackTitle: string,
    channelOpts: { syncPlaylists?: boolean; syncVideos?: boolean } = {}
  ): Promise<{ id: number; name: string }> => {
    const existing = db
      .prepare('SELECT id, name FROM channels WHERE youtube_channel_id = ? LIMIT 1')
      .get(youtubeChannelId) as { id: number; name: string } | undefined;
    if (existing) return existing;

    const infos = await ytFetchChannelsFn([youtubeChannelId]).catch(() => []);
    const info: YtChannelInfo = infos[0] || {
      id: youtubeChannelId,
      title: fallbackTitle || youtubeChannelId,
      description: '',
      customUrl: null,
      avatarUrl: null,
      uploadsPlaylistId: youtubeChannelId.startsWith('UC') ? `UU${youtubeChannelId.slice(2)}` : null,
      videoCount: 0,
    };
    const id = upsertChannel(db, {
      info,
      handle: info.customUrl,
      category: 'anime',
      regionFocus: 'Global',
      subLanguages: ['en'],
      discoverySource: 'manual',
      isVerified: true,
      playlistCount: 0,
      syncPlaylists: channelOpts.syncPlaylists,
      syncVideos: channelOpts.syncVideos,
    });
    return { id, name: info.title };
  };

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

  app.get('/api/admin/session', (c) => {
    return c.json({ ok: true, isAdmin: true });
  });

  app.get('/api/admin/youtube/search', async (c) => {
    const q = (c.req.query('q') || '').trim().slice(0, 120);
    if (!q) return c.json({ error: 'q is required' }, 400);
    const rawMode = c.req.query('mode');
    const mode = rawMode === 'songs' ? 'songs' : rawMode === 'videos' ? 'videos' : 'anime';

    try {
      if (mode === 'songs') {
        const hasSongKw = /\b(?:op|ed|ost|opening|ending|soundtrack|theme|mv)\b|片頭|片尾|主題曲|原聲帶/i.test(q);
        const ytQuery = hasSongKw ? q : `${q} anime OP ED OST`;
        const results = await ytSearchFn(ytQuery, 'video', 8);
        const existingRows =
          results.length > 0
            ? (db
                .prepare(`SELECT youtube_video_id FROM songs WHERE youtube_video_id IN (${results.map(() => '?').join(',')})`)
                .all(...results.map((r) => r.id)) as unknown as Array<{ youtube_video_id: string }>)
            : [];
        const existingSet = new Set(existingRows.map((r) => r.youtube_video_id));

        return c.json({
          ok: true,
          mode,
          query: q,
          results: results.map((r) => ({
            ...r,
            suggestedSongType: classifyAnimeSong(r.title) || 'ost',
            alreadyInDb: existingSet.has(r.id),
          })),
        });
      }

      if (mode === 'videos') {
        const results = await ytSearchFn(q, 'video', 8);
        const chIds = [...new Set(results.map((r) => r.channelId).filter(Boolean))];
        const vidIds = [...new Set(results.map((r) => r.id).filter(Boolean))];
        const chSet = new Set(
          chIds.length > 0
            ? (
                db
                  .prepare(`SELECT youtube_channel_id FROM channels WHERE youtube_channel_id IN (${chIds.map(() => '?').join(',')})`)
                  .all(...chIds) as unknown as Array<{ youtube_channel_id: string }>
              ).map((r) => r.youtube_channel_id)
            : []
        );
        const vidSet = new Set(
          vidIds.length > 0
            ? (
                db
                  .prepare(`SELECT youtube_video_id FROM episodes WHERE youtube_video_id IN (${vidIds.map(() => '?').join(',')})`)
                  .all(...vidIds) as unknown as Array<{ youtube_video_id: string }>
              ).map((r) => r.youtube_video_id)
            : []
        );

        return c.json({
          ok: true,
          mode,
          query: q,
          results: results.map((r) => ({
            ...r,
            channelInDb: chSet.has(r.channelId),
            videoInDb: vidSet.has(r.id),
          })),
        });
      }

      const hasAnimeKw = /anime|donghua|動畫|動漫|番劇/i.test(q);
      const ytQuery = hasAnimeKw ? q : `${q} anime`;
      const results = await ytSearchFn(ytQuery, 'playlist', 8);
      const chIds = [...new Set(results.map((r) => r.channelId).filter(Boolean))];
      const plIds = [...new Set(results.map((r) => r.id).filter(Boolean))];

      const chSet = new Set(
        chIds.length > 0
          ? (
              db
                .prepare(`SELECT youtube_channel_id FROM channels WHERE youtube_channel_id IN (${chIds.map(() => '?').join(',')})`)
                .all(...chIds) as unknown as Array<{ youtube_channel_id: string }>
            ).map((r) => r.youtube_channel_id)
          : []
      );
      const plSet = new Set(
        plIds.length > 0
          ? (
              db
                .prepare(`SELECT playlist_id FROM channel_series WHERE playlist_id IN (${plIds.map(() => '?').join(',')})`)
                .all(...plIds) as unknown as Array<{ playlist_id: string }>
            ).map((r) => r.playlist_id)
          : []
      );

      return c.json({
        ok: true,
        mode,
        query: q,
        results: results.map((r) => ({
          ...r,
          channelInDb: chSet.has(r.channelId),
          playlistInDb: plSet.has(r.id),
        })),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'YouTube search failed' }, 502);
    }
  });

  app.post('/api/admin/youtube/import-playlist', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      playlistId?: unknown;
      playlistTitle?: unknown;
      channelId?: unknown;
      channelTitle?: unknown;
      thumbnailUrl?: unknown;
    };
    const playlistId = typeof body.playlistId === 'string' ? body.playlistId.trim() : '';
    const playlistTitle = typeof body.playlistTitle === 'string' ? body.playlistTitle.trim() : '';
    const youtubeChannelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
    const channelTitle = typeof body.channelTitle === 'string' ? body.channelTitle.trim() : '';
    const thumbnailUrl = typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl.trim() : null;

    if (!playlistId || !youtubeChannelId) {
      return c.json({ error: 'playlistId and channelId are required' }, 400);
    }

    try {
      const ch = await ensureChannelInDb(youtubeChannelId, channelTitle || youtubeChannelId, {
        syncPlaylists: true,
        syncVideos: true,
      });

      const items = await ytFetchPlaylistItemsFn(playlistId, 10);
      const validItems = items.filter(
        (it) => !isPromoVideo(it.title) && !isMembersOnlyText(`${it.title} ${it.description}`)
      );
      if (validItems.length === 0) {
        return c.json({ error: 'No public non-promo videos found in this playlist' }, 422);
      }

      const rawTitle = playlistTitle || validItems[0].title;
      const detectedLang = detectSubLanguage(`${rawTitle} ${validItems[0]?.title || ''}`, 'en');
      const subLang = detectedLang === 'other' ? 'en' : detectedLang;
      const cleaned = cleanSeriesTitle(rawTitle);
      const key = normalizeSeriesKey(cleaned);

      let seriesRow = db
        .prepare('SELECT id, slug FROM series WHERE normalized_key = ? LIMIT 1')
        .get(key) as { id: number; slug: string } | undefined;

      if (!seriesRow) {
        const slug = ensureUniqueSlug(db, cleaned);
        const titleEn = subLang === 'en' || !detectChineseScript(cleaned) ? cleaned : null;
        const titleZh = subLang.startsWith('zh') || detectChineseScript(cleaned) ? cleaned : null;
        const ins = db
          .prepare('INSERT INTO series (slug, canonical_title, normalized_key, title_en, title_zh) VALUES (?, ?, ?, ?, ?)')
          .run(slug, cleaned, key, titleEn, titleZh);
        seriesRow = { id: Number(ins.lastInsertRowid), slug };
      }

      const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
      const thumb = thumbnailUrl || validItems[0]?.thumbnailUrl || null;
      db.prepare(
        `INSERT INTO channel_series (
          channel_id, series_id, playlist_id, playlist_title, playlist_url,
          thumbnail_url, sub_language, episode_count, playlist_item_count, access_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'free')
        ON CONFLICT(channel_id, playlist_id) DO UPDATE SET
          series_id = excluded.series_id,
          playlist_title = excluded.playlist_title,
          thumbnail_url = COALESCE(excluded.thumbnail_url, channel_series.thumbnail_url),
          sub_language = excluded.sub_language,
          episode_count = excluded.episode_count,
          playlist_item_count = excluded.playlist_item_count`
      ).run(ch.id, seriesRow.id, playlistId, rawTitle, playlistUrl, thumb, subLang, validItems.length, items.length);

      const csRow = db
        .prepare('SELECT id FROM channel_series WHERE channel_id = ? AND playlist_id = ?')
        .get(ch.id, playlistId) as { id: number };

      const detailsMap = await ytFetchVideoDetailsFn(validItems.map((v) => v.videoId)).catch(
        () => new Map<string, YtVideoDetail>()
      );

      const insertEp = db.prepare(
        `INSERT INTO episodes (
          channel_series_id, series_id, channel_id, youtube_video_id,
          title, description, episode_number, playlist_position, sub_language,
          duration_iso, thumbnail_url, published_at, view_count, like_count, comment_count,
          tags, expires_at, region_allowed, region_blocked, details_synced_at, is_members_only
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), 0)
        ON CONFLICT(channel_series_id, youtube_video_id) DO UPDATE SET
          title = excluded.title,
          duration_iso = COALESCE(excluded.duration_iso, episodes.duration_iso),
          view_count = COALESCE(excluded.view_count, episodes.view_count),
          like_count = COALESCE(excluded.like_count, episodes.like_count),
          comment_count = COALESCE(excluded.comment_count, episodes.comment_count),
          region_allowed = COALESCE(excluded.region_allowed, episodes.region_allowed),
          region_blocked = COALESCE(excluded.region_blocked, episodes.region_blocked),
          is_members_only = 0`
      );

      let importedEpisodes = 0;
      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const it of validItems) {
          const d = detailsMap.get(it.videoId);
          if (d && (!d.embeddable || d.isMembersOnly || isMembersOnlyText(`${d.title} ${d.description}`))) {
            continue;
          }
          const epNum = extractEpisodeNumber(it.title);
          const epLang = detectSubLanguage(it.title, subLang);
          const pubMs = Date.parse(d?.publishedAt || it.publishedAt || '');
          const pubSec = Number.isFinite(pubMs) ? Math.floor(pubMs / 1000) : null;
          insertEp.run(
            csRow.id,
            seriesRow.id,
            ch.id,
            it.videoId,
            d?.title || it.title,
            (d?.description || it.description || '').slice(0, 2000) || null,
            epNum,
            it.position,
            epLang === 'other' ? subLang : epLang,
            d?.durationIso ?? null,
            d?.thumbnailUrl || it.thumbnailUrl,
            pubSec,
            d?.viewCount ?? null,
            d?.likeCount ?? null,
            d?.commentCount ?? null,
            JSON.stringify((d?.tags || []).slice(0, 15)),
            extractExpiryDate(d?.description || it.description || ''),
            d && d.regionAllowed.length > 0 ? JSON.stringify(d.regionAllowed) : null,
            d && d.regionBlocked.length > 0 ? JSON.stringify(d.regionBlocked) : null
          );
          importedEpisodes++;
        }
        db.prepare(
          'UPDATE channel_series SET episode_count = (SELECT COUNT(*) FROM episodes WHERE channel_series_id = ? AND is_members_only = 0) WHERE id = ?'
        ).run(csRow.id, csRow.id);
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      refreshSeriesStats(db, seriesRow.id);
      return c.json({
        ok: true,
        channelId: ch.id,
        channelName: ch.name,
        seriesId: seriesRow.id,
        seriesSlug: seriesRow.slug,
        importedEpisodes,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed importing playlist' }, 502);
    }
  });

  app.post('/api/admin/youtube/import-video', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      videoId?: unknown;
      title?: unknown;
      channelId?: unknown;
      channelTitle?: unknown;
      thumbnailUrl?: unknown;
      publishedAt?: unknown;
    };
    const videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const youtubeChannelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
    const channelTitle = typeof body.channelTitle === 'string' ? body.channelTitle.trim() : '';
    const thumbnailUrl = typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl.trim() : null;
    const publishedAtStr = typeof body.publishedAt === 'string' ? body.publishedAt.trim() : null;

    if (!videoId || !youtubeChannelId) {
      return c.json({ error: 'videoId and channelId are required' }, 400);
    }

    try {
      const ch = await ensureChannelInDb(youtubeChannelId, channelTitle || youtubeChannelId, {
        syncPlaylists: true,
        syncVideos: true,
      });

      const detailsMap = await ytFetchVideoDetailsFn([videoId]).catch(() => new Map<string, YtVideoDetail>());
      const d = detailsMap.get(videoId);
      if (d && (!d.embeddable || d.isMembersOnly || isMembersOnlyText(`${d.title} ${d.description}`))) {
        return c.json({ error: 'This YouTube video is not publicly embeddable' }, 422);
      }

      const finalTitle = d?.title || rawTitle || videoId;
      const detectedLang = detectSubLanguage(finalTitle, 'en');
      const subLang = detectedLang === 'other' ? 'en' : detectedLang;
      const cleaned = cleanSeriesTitle(finalTitle);
      const key = normalizeSeriesKey(cleaned);

      let seriesRow = db
        .prepare('SELECT id, slug FROM series WHERE normalized_key = ? LIMIT 1')
        .get(key) as { id: number; slug: string } | undefined;

      if (!seriesRow) {
        const slug = ensureUniqueSlug(db, cleaned);
        const titleEn = subLang === 'en' || !detectChineseScript(cleaned) ? cleaned : null;
        const titleZh = subLang.startsWith('zh') || detectChineseScript(cleaned) ? cleaned : null;
        const ins = db
          .prepare('INSERT INTO series (slug, canonical_title, normalized_key, title_en, title_zh) VALUES (?, ?, ?, ?, ?)')
          .run(slug, cleaned, key, titleEn, titleZh);
        seriesRow = { id: Number(ins.lastInsertRowid), slug };
      }

      const virtualPlaylistId = `uploads:${key.slice(0, 64)}`;
      const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      const thumb = d?.thumbnailUrl || thumbnailUrl || null;
      const epNum = extractEpisodeNumber(finalTitle);
      const pubMs = Date.parse(d?.publishedAt || publishedAtStr || '');
      const pubSec = Number.isFinite(pubMs) ? Math.floor(pubMs / 1000) : null;

      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(
          `INSERT INTO channel_series (
            channel_id, series_id, playlist_id, playlist_title, playlist_url,
            thumbnail_url, sub_language, episode_count, access_note
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'free')
          ON CONFLICT(channel_id, playlist_id) DO UPDATE SET
            series_id = excluded.series_id,
            thumbnail_url = COALESCE(excluded.thumbnail_url, channel_series.thumbnail_url)`
        ).run(ch.id, seriesRow.id, virtualPlaylistId, cleaned, videoUrl, thumb, subLang);

        const csRow = db
          .prepare('SELECT id FROM channel_series WHERE channel_id = ? AND playlist_id = ?')
          .get(ch.id, virtualPlaylistId) as { id: number };

        db.prepare(
          `INSERT INTO episodes (
            channel_series_id, series_id, channel_id, youtube_video_id,
            title, description, episode_number, playlist_position, sub_language,
            duration_iso, thumbnail_url, published_at, view_count, like_count, comment_count,
            tags, expires_at, region_allowed, region_blocked, details_synced_at, is_members_only
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), 0)
          ON CONFLICT(channel_series_id, youtube_video_id) DO UPDATE SET
            title = excluded.title,
            duration_iso = COALESCE(excluded.duration_iso, episodes.duration_iso),
            view_count = COALESCE(excluded.view_count, episodes.view_count),
            like_count = COALESCE(excluded.like_count, episodes.like_count),
            comment_count = COALESCE(excluded.comment_count, episodes.comment_count),
            region_allowed = COALESCE(excluded.region_allowed, episodes.region_allowed),
            region_blocked = COALESCE(excluded.region_blocked, episodes.region_blocked),
            is_members_only = 0`
        ).run(
          csRow.id,
          seriesRow.id,
          ch.id,
          videoId,
          finalTitle,
          (d?.description || '').slice(0, 2000) || null,
          epNum,
          subLang,
          d?.durationIso ?? null,
          thumb,
          pubSec,
          d?.viewCount ?? null,
          d?.likeCount ?? null,
          d?.commentCount ?? null,
          JSON.stringify((d?.tags || []).slice(0, 15)),
          extractExpiryDate(d?.description || ''),
          d && d.regionAllowed.length > 0 ? JSON.stringify(d.regionAllowed) : null,
          d && d.regionBlocked.length > 0 ? JSON.stringify(d.regionBlocked) : null
        );

        db.prepare(
          'UPDATE channel_series SET episode_count = (SELECT COUNT(*) FROM episodes WHERE channel_series_id = ? AND is_members_only = 0) WHERE id = ?'
        ).run(csRow.id, csRow.id);
        db.exec('COMMIT;');
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }

      refreshSeriesStats(db, seriesRow.id);
      return c.json({
        ok: true,
        channelId: ch.id,
        channelName: ch.name,
        seriesId: seriesRow.id,
        seriesSlug: seriesRow.slug,
        youtubeVideoId: videoId,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed importing video' }, 502);
    }
  });

  app.post('/api/admin/youtube/import-song', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      videoId?: unknown;
      title?: unknown;
      channelId?: unknown;
      channelTitle?: unknown;
      songType?: unknown;
      thumbnailUrl?: unknown;
      publishedAt?: unknown;
    };
    const videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const youtubeChannelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
    const channelTitle = typeof body.channelTitle === 'string' ? body.channelTitle.trim() : '';
    const thumbnailUrl = typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl.trim() : null;
    const publishedAtStr = typeof body.publishedAt === 'string' ? body.publishedAt.trim() : null;

    if (!videoId || !youtubeChannelId) {
      return c.json({ error: 'videoId and channelId are required' }, 400);
    }

    try {
      const ch = await ensureChannelInDb(youtubeChannelId, channelTitle || youtubeChannelId, {
        syncPlaylists: false,
        syncVideos: false,
      });

      const detailsMap = await ytFetchVideoDetailsFn([videoId]).catch(() => new Map<string, YtVideoDetail>());
      const d = detailsMap.get(videoId);
      if (d && (!d.embeddable || d.isMembersOnly)) {
        return c.json({ error: 'This YouTube video is not publicly embeddable' }, 422);
      }

      const finalTitle = d?.title || rawTitle || videoId;
      const requestedType: SongType | null =
        body.songType === 'op' || body.songType === 'ed' || body.songType === 'ost' ? body.songType : null;
      const songType: SongType = requestedType || classifyAnimeSong(finalTitle) || 'ost';
      const animeTitle = cleanSeriesTitle(finalTitle) || null;
      const key = animeTitle ? normalizeSeriesKey(animeTitle) : '';
      const matchedSeries = key
        ? (db.prepare('SELECT id FROM series WHERE normalized_key = ? LIMIT 1').get(key) as { id: number } | undefined)
        : undefined;

      const pubMs = Date.parse(d?.publishedAt || publishedAtStr || '');
      const pubSec = Number.isFinite(pubMs) ? Math.floor(pubMs / 1000) : null;

      db.prepare(
        `INSERT INTO songs (
          channel_id, series_id, youtube_video_id, title, song_type, anime_title,
          duration_iso, thumbnail_url, published_at, view_count, like_count,
          region_allowed, region_blocked
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(youtube_video_id) DO UPDATE SET
          series_id = COALESCE(excluded.series_id, songs.series_id),
          title = excluded.title,
          song_type = excluded.song_type,
          anime_title = COALESCE(excluded.anime_title, songs.anime_title),
          duration_iso = COALESCE(excluded.duration_iso, songs.duration_iso),
          thumbnail_url = COALESCE(excluded.thumbnail_url, songs.thumbnail_url),
          published_at = COALESCE(excluded.published_at, songs.published_at),
          view_count = COALESCE(excluded.view_count, songs.view_count),
          like_count = COALESCE(excluded.like_count, songs.like_count),
          region_allowed = COALESCE(excluded.region_allowed, songs.region_allowed),
          region_blocked = COALESCE(excluded.region_blocked, songs.region_blocked)`
      ).run(
        ch.id,
        matchedSeries?.id ?? null,
        videoId,
        finalTitle,
        songType,
        animeTitle,
        d?.durationIso ?? null,
        d?.thumbnailUrl || thumbnailUrl,
        pubSec,
        d?.viewCount ?? null,
        d?.likeCount ?? null,
        d && d.regionAllowed.length > 0 ? JSON.stringify(d.regionAllowed) : null,
        d && d.regionBlocked.length > 0 ? JSON.stringify(d.regionBlocked) : null
      );

      return c.json({
        ok: true,
        song: {
          youtubeVideoId: videoId,
          title: finalTitle,
          songType,
          channelName: ch.name,
        },
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed importing song' }, 502);
    }
  });

  app.get('/api/admin/channels', (c) => {
    const verifiedRows = db
      .prepare(
        `SELECT c.id, c.youtube_channel_id, c.handle, c.name, c.url, c.avatar_url,
                c.sub_languages, c.category, c.discovery_source, c.playlist_count,
                c.sync_playlists, c.sync_videos, c.last_synced_at,
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
                sub_languages, category, discovery_source, playlist_count,
                sync_playlists, sync_videos, created_at
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
        syncPlaylists: r.sync_playlists !== 0,
        syncVideos: r.sync_videos !== 0,
        lastSyncedAt: r.last_synced_at ?? null,
        seriesCount: r.series_count ?? 0,
        totalEpisodes: r.total_episodes ?? 0,
      };
    };

    return c.json({
      verified: verifiedRows.map(mapRow),
      candidates: candidateRows.map(mapRow),
      jobs: opts.jobs?.getStatus() ?? null,
      quota: getYouTubeQuotaStatus(db),
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
      syncPlaylists?: unknown;
      syncVideos?: unknown;
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
    const syncPlaylists = typeof body.syncPlaylists === 'boolean' ? body.syncPlaylists : true;
    const syncVideos = typeof body.syncVideos === 'boolean' ? body.syncVideos : true;

    try {
      const result = await addChannelFn(db, rawChannel, {
        category,
        regionFocus,
        subLanguages: subLanguages && subLanguages.length > 0 ? subLanguages : undefined,
        discoverySource: 'manual',
        force: Boolean(body.force),
        syncPlaylists,
        syncVideos,
      });
      if (!result.ok) {
        return c.json({ error: result.reason || 'Channel verification failed', channel: result }, 422);
      }
      const scope = syncScopeFromFlags(syncPlaylists, syncVideos);
      const syncQueued =
        body.syncNow !== false && scope !== null
          ? Boolean(opts.jobs?.triggerChannelSync(result.youtubeChannelId, scope))
          : false;
      return c.json({ ok: true, channel: result, syncQueued });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed adding channel' }, 400);
    }
  });

  app.patch('/api/admin/channels/:id/sync-options', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      syncPlaylists?: unknown;
      syncVideos?: unknown;
    };
    const existing = db
      .prepare('SELECT id, sync_playlists, sync_videos FROM channels WHERE id = ? LIMIT 1')
      .get(id) as { id: number; sync_playlists: number; sync_videos: number } | undefined;
    if (!existing) return c.json({ error: 'Channel not found' }, 404);

    const nextPlaylists =
      typeof body.syncPlaylists === 'boolean' ? (body.syncPlaylists ? 1 : 0) : existing.sync_playlists;
    const nextVideos =
      typeof body.syncVideos === 'boolean' ? (body.syncVideos ? 1 : 0) : existing.sync_videos;

    db.prepare('UPDATE channels SET sync_playlists = ?, sync_videos = ? WHERE id = ?').run(
      nextPlaylists,
      nextVideos,
      id
    );
    return c.json({
      ok: true,
      id,
      syncPlaylists: nextPlaylists !== 0,
      syncVideos: nextVideos !== 0,
    });
  });

  app.delete('/api/admin/channels/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const deleted = deleteChannelAndCleanup(db, id);
    if (!deleted) return c.json({ error: 'Channel not found' }, 404);
    return c.json({ ok: true, deleted });
  });

  app.get('/api/admin/channels/:id/playlists', (c) => {
    const channelId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(channelId) || channelId <= 0) return c.json({ error: 'Invalid id' }, 400);
    const ch = db.prepare('SELECT id FROM channels WHERE id = ? LIMIT 1').get(channelId);
    if (!ch) return c.json({ error: 'Channel not found' }, 404);

    const q = (c.req.query('q') || '').trim();
    const where: string[] = ['cs.channel_id = ?'];
    const params: Array<string | number> = [channelId];
    if (q) {
      const like = `%${q}%`;
      where.push('(cs.playlist_title LIKE ? OR cs.playlist_id LIKE ? OR COALESCE(s.canonical_title, \'\') LIKE ?)');
      params.push(like, like, like);
    }

    const rows = db
      .prepare(
        `SELECT cs.id, cs.playlist_id, cs.playlist_title, cs.playlist_url, cs.sub_language,
                cs.published_at, s.canonical_title AS series_title,
                (SELECT COUNT(*) FROM episodes e WHERE e.channel_series_id = cs.id) AS episode_count
         FROM channel_series cs
         LEFT JOIN series s ON s.id = cs.series_id
         WHERE ${where.join(' AND ')}
         ORDER BY cs.playlist_title COLLATE NOCASE ASC`
      )
      .all(...params) as unknown as Array<Record<string, unknown>>;

    return c.json({
      playlists: rows.map((r) => ({
        id: r.id,
        playlistId: r.playlist_id,
        playlistTitle: r.playlist_title,
        playlistUrl: r.playlist_url,
        subLanguage: r.sub_language,
        publishedAt: r.published_at ?? null,
        seriesTitle: r.series_title ?? null,
        episodeCount: r.episode_count ?? 0,
      })),
    });
  });

  app.delete('/api/admin/channels/:id/playlists/:channelSeriesId', (c) => {
    const channelId = parseInt(c.req.param('id'), 10);
    const channelSeriesId = parseInt(c.req.param('channelSeriesId'), 10);
    if (!Number.isFinite(channelId) || channelId <= 0 || !Number.isFinite(channelSeriesId) || channelSeriesId <= 0) {
      return c.json({ error: 'Invalid id' }, 400);
    }
    const deleted = deletePlaylistAndCleanup(db, channelId, channelSeriesId);
    if (!deleted) return c.json({ error: 'Playlist not found for this channel' }, 404);
    return c.json({ ok: true, deleted });
  });

  app.get('/api/admin/channels/:id/videos', (c) => {
    const channelId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(channelId) || channelId <= 0) return c.json({ error: 'Invalid id' }, 400);
    const ch = db.prepare('SELECT id FROM channels WHERE id = ? LIMIT 1').get(channelId);
    if (!ch) return c.json({ error: 'Channel not found' }, 404);

    const q = (c.req.query('q') || '').trim();
    const csRaw = c.req.query('channelSeriesId');
    const channelSeriesId = csRaw ? parseInt(csRaw, 10) : NaN;
    const limitRaw = parseInt(c.req.query('limit') || '200', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 200;

    const where: string[] = ['e.channel_id = ?'];
    const params: Array<string | number> = [channelId];
    if (Number.isFinite(channelSeriesId) && channelSeriesId > 0) {
      where.push('e.channel_series_id = ?');
      params.push(channelSeriesId);
    }
    if (q) {
      const like = `%${q}%`;
      where.push('(e.title LIKE ? OR e.youtube_video_id LIKE ? OR COALESCE(cs.playlist_title, \'\') LIKE ?)');
      params.push(like, like, like);
    }

    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM episodes e
         LEFT JOIN channel_series cs ON cs.id = e.channel_series_id
         WHERE ${where.join(' AND ')}`
      )
      .get(...params) as { cnt: number };

    const rows = db
      .prepare(
        `SELECT e.id, e.channel_series_id, e.youtube_video_id, e.title, e.episode_number,
                e.playlist_position, e.sub_language, e.published_at, cs.playlist_title
         FROM episodes e
         LEFT JOIN channel_series cs ON cs.id = e.channel_series_id
         WHERE ${where.join(' AND ')}
         ORDER BY cs.playlist_title COLLATE NOCASE ASC, e.episode_number ASC, e.playlist_position ASC, e.id ASC
         LIMIT ?`
      )
      .all(...params, limit) as unknown as Array<Record<string, unknown>>;

    return c.json({
      total: totalRow?.cnt || 0,
      videos: rows.map((r) => ({
        id: r.id,
        channelSeriesId: r.channel_series_id,
        youtubeVideoId: r.youtube_video_id,
        title: r.title,
        episodeNumber: r.episode_number ?? null,
        playlistPosition: r.playlist_position ?? 0,
        subLanguage: r.sub_language,
        publishedAt: r.published_at ?? null,
        playlistTitle: r.playlist_title ?? null,
      })),
    });
  });

  app.delete('/api/admin/channels/:id/videos/:episodeId', (c) => {
    const channelId = parseInt(c.req.param('id'), 10);
    const episodeId = parseInt(c.req.param('episodeId'), 10);
    if (!Number.isFinite(channelId) || channelId <= 0 || !Number.isFinite(episodeId) || episodeId <= 0) {
      return c.json({ error: 'Invalid id' }, 400);
    }
    const deleted = deleteEpisodeAndCleanup(db, channelId, episodeId);
    if (!deleted) return c.json({ error: 'Video not found for this channel' }, 404);
    return c.json({ ok: true, deleted });
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

  app.post('/api/admin/channels/:id/sync', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: 'Invalid id' }, 400);
    const ch = db
      .prepare('SELECT youtube_channel_id, sync_playlists, sync_videos FROM channels WHERE id = ? AND is_verified = 1 LIMIT 1')
      .get(id) as { youtube_channel_id: string; sync_playlists: number; sync_videos: number } | undefined;
    if (!ch) return c.json({ error: 'Verified channel not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown };
    const explicitScope = parseSyncScope(body.scope);
    const effectiveScope = explicitScope ?? syncScopeFromFlags(ch.sync_playlists !== 0, ch.sync_videos !== 0);
    if (!effectiveScope) {
      return c.json({ error: 'Both playlists and channel videos sync are disabled for this channel' }, 400);
    }

    const queued = Boolean(opts.jobs?.triggerChannelSync(ch.youtube_channel_id, effectiveScope));
    return c.json({ ok: true, queued, scope: effectiveScope });
  });

  app.get('/api/admin/jobs', (c) => {
    return c.json({ jobs: opts.jobs?.getStatus() ?? null, quota: getYouTubeQuotaStatus(db) });
  });

  app.post('/api/admin/jobs/run-now', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { jobId?: unknown };
    const jobId = typeof body.jobId === 'string' && body.jobId.trim() ? body.jobId.trim() : undefined;
    const result = opts.jobs?.runQueuedNow(jobId);
    if (!result || !result.ok) {
      return c.json({ error: 'No matching queued job to run' }, 400);
    }
    return c.json({
      ok: true,
      startedOrPromoted: result.startedOrPromoted,
      preemptedRunningJob: result.preemptedRunningJob,
      jobs: opts.jobs?.getStatus() ?? null,
      quota: getYouTubeQuotaStatus(db),
    });
  });

  app.post('/api/admin/jobs/remove', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { jobId?: unknown };
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
    if (!jobId) {
      return c.json({ error: 'jobId is required' }, 400);
    }
    const result = opts.jobs?.removeQueuedJob(jobId);
    if (!result || !result.ok) {
      return c.json({ error: 'No matching queued job to remove' }, 404);
    }
    return c.json({
      ok: true,
      removedLabel: result.removedLabel,
      jobs: opts.jobs?.getStatus() ?? null,
      quota: getYouTubeQuotaStatus(db),
    });
  });

  app.post('/api/admin/sync/incremental', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown };
    const scope = parseSyncScope(body.scope);
    return c.json({ ok: true, queued: Boolean(opts.jobs?.triggerIncrementalSync(scope)), scope: scope ?? null });
  });
  app.post('/api/admin/sync/full', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: unknown };
    const scope = parseSyncScope(body.scope);
    return c.json({ ok: true, queued: Boolean(opts.jobs?.triggerFullSync(scope)), scope: scope ?? null });
  });
  app.post('/api/admin/sync/live', (c) => c.json({ ok: true, queued: Boolean(opts.jobs?.triggerLiveCheck()) }));
  app.post('/api/admin/sync/songs', (c) => c.json({ ok: true, queued: Boolean(opts.jobs?.triggerSongSync()) }));
  app.post('/api/admin/discover', (c) => c.json({ ok: true, queued: Boolean(opts.jobs?.triggerDiscovery()) }));

  app.post('/api/admin/logout', (c) => {
    const secret = getConfiguredAdminToken();
    if (secret) setSessionCookie(c, secret, true);
    return c.json({ ok: true });
  });
}
