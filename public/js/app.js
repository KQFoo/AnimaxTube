(() => {
  const STORAGE_SAVED = 'animaxtube_saved_v1';
  const STORAGE_HISTORY = 'animaxtube_history_v1';
  const STORAGE_REGION = 'animaxtube_region_v1';
  const STORAGE_THEME = 'animaxtube_theme_v1';

  const TIMEZONE_TO_REGION = {
    'Asia/Kuala_Lumpur': 'MY',
    'Asia/Kuching': 'MY',
    'Asia/Singapore': 'SG',
    'Asia/Taipei': 'TW',
    'Asia/Hong_Kong': 'HK',
    'Asia/Macau': 'HK',
    'Asia/Manila': 'PH',
    'Asia/Jakarta': 'ID',
    'Asia/Makassar': 'ID',
    'Asia/Jayapura': 'ID',
    'Asia/Bangkok': 'TH',
    'Asia/Ho_Chi_Minh': 'VN',
    'Asia/Saigon': 'VN',
    'Asia/Kolkata': 'IN',
    'Asia/Calcutta': 'IN',
    'Asia/Tokyo': 'JP',
    'Asia/Seoul': 'KR',
    'Europe/London': 'GB',
    'Australia/Sydney': 'AU',
    'Australia/Melbourne': 'AU',
    'Australia/Brisbane': 'AU',
    'Australia/Perth': 'AU',
  };

  const SITE_TITLE = 'AnimaxTube';
  const VIEW_TITLES = {
    channels: 'Official Licensed Anime Channels on YouTube | AnimaxTube',
    calendar: 'YouTube Anime Release Calendar & Schedule | AnimaxTube',
    songs: 'Anime Songs — Official OP, ED & OST on YouTube | AnimaxTube',
    watchlist: 'Watchlist | AnimaxTube',
    history: 'Watch History | AnimaxTube',
    about: 'About, Legal & DMCA | AnimaxTube',
  };

  // Territories covered by the Asia-focused licensees (Muse, Ani-One, etc.).
  const ASIA_REGION_CODES = new Set([
    'MY', 'SG', 'PH', 'ID', 'TH', 'VN', 'KH', 'LA', 'MM', 'BN', 'TL',
    'IN', 'BD', 'PK', 'LK', 'NP', 'BT', 'MV', 'AF',
    'TW', 'HK', 'MO', 'CN', 'JP', 'KR', 'MN',
  ]);
  const OCEANIA_REGION_CODES = new Set(['AU', 'NZ', 'FJ', 'PG']);

  const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

  function getConnectionInfo() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }

  function isConstrainedNetwork() {
    const conn = getConnectionInfo();
    if (!conn) return false;
    return Boolean(conn.saveData || conn.effectiveType === '2g' || conn.effectiveType === 'slow-2g');
  }

  function getShelfLimit() {
    return isConstrainedNetwork() ? 8 : 12;
  }

  function getPageLimit() {
    const conn = getConnectionInfo();
    if (isConstrainedNetwork()) return 12;
    if (window.innerWidth <= 768 || conn?.effectiveType === '3g') return 18;
    return 30;
  }

  function optimizeThumbUrl(url) {
    if (!url) return '';
    return url.replace(
      /^(https?:\/\/i\.ytimg\.com\/vi(?:_webp)?\/[^/]+\/)(?:maxresdefault|sddefault|hqdefault)(\.(?:jpg|webp))(?:\?.*)?$/i,
      '$1mqdefault$2'
    );
  }

  const PLAY_OVERLAY =
    '<div class="thumb-play" aria-hidden="true"><span><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></div>';
  const BOOKMARK_OUTLINE_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 4h12v17l-6-3.8L6 21V4z"/></svg>';
  const BOOKMARK_FILLED_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M6 4h12v17l-6-3.8L6 21V4z"/></svg>';
  const REMOVE_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const seriesCatalog = new Map();
  let seriesAbortCtrl = null;
  let loadMoreObserver = null;
  let adminSessionChecked = false;
  let isAdminSession = false;

  async function checkAdminSession() {
    if (adminSessionChecked) return isAdminSession;
    adminSessionChecked = true;
    try {
      const res = await fetch('/api/admin/session', { credentials: 'same-origin' });
      isAdminSession = res.ok;
    } catch {
      isAdminSession = false;
    }
    return isAdminSession;
  }

  async function adminApi(url, method = 'GET', body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { 'X-Admin-Action': '1' },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function maybeMountAdminYtSearch(container, mode, query, hasLocalResults = false) {
    const cleanQ = (query || '').trim();
    if (!container || !cleanQ) return;
    const ok = await checkAdminSession();
    if (!ok) return;
    const activeQ = mode === 'songs' ? (state.songs.q || '').trim() : (state.q || '').trim();
    if (activeQ !== cleanQ) return;
    if (container.querySelector('.admin-yt-box')) return;

    const box = document.createElement('div');
    box.className = 'admin-yt-box';
    const label = mode === 'songs' ? 'YouTube Songs' : 'YouTube Playlists & Videos';
    const heading = hasLocalResults
      ? `Search ${label} for "${escapeHtml(cleanQ)}"`
      : `No local match for "${escapeHtml(cleanQ)}" — Search ${label}`;
    const buttonsHtml =
      mode === 'songs'
        ? `<button type="button" class="btn-primary admin-yt-search-btn" data-yt-mode="songs">Search YouTube Songs (~100 quota)</button>`
        : `<div class="admin-yt-actions" style="padding-top:0;margin-top:0;">
            <button type="button" class="btn-primary admin-yt-search-btn" data-yt-mode="anime">Search Playlists (~100 quota)</button>
            <button type="button" class="btn-secondary admin-yt-search-btn" data-yt-mode="videos">Search Videos (~100 quota)</button>
          </div>`;
    box.innerHTML = `
      <div class="admin-yt-head">
        <div class="admin-yt-title">
          <span class="admin-yt-badge">Admin</span>
          <span>${heading}</span>
        </div>
        ${buttonsHtml}
      </div>
      <div class="admin-yt-status"></div>
      <div class="admin-yt-grid"></div>
    `;
    if (hasLocalResults) {
      container.prepend(box);
    } else {
      container.appendChild(box);
    }

    const searchBtns = [...box.querySelectorAll('.admin-yt-search-btn')];
    const statusNode = box.querySelector('.admin-yt-status');
    const gridNode = box.querySelector('.admin-yt-grid');

    const setYtStatus = (msg, isErr = false) => {
      statusNode.textContent = msg || '';
      statusNode.className = isErr ? 'admin-yt-status error' : 'admin-yt-status';
    };

    const runYtSearch = async (searchMode) => {
      searchBtns.forEach((b) => { b.disabled = true; });
      const kindLabel = searchMode === 'songs' ? 'songs' : searchMode === 'videos' ? 'videos' : 'playlists';
      setYtStatus(`Searching YouTube ${kindLabel} for "${cleanQ}"…`);
      gridNode.innerHTML = '';
      try {
        const data = await adminApi(
          `/api/admin/youtube/search?mode=${encodeURIComponent(searchMode)}&q=${encodeURIComponent(cleanQ)}`
        );
        const results = data.results || [];
        if (results.length === 0) {
          setYtStatus(`No YouTube ${kindLabel} found for "${cleanQ}".`);
          return;
        }
        setYtStatus(`Found ${results.length} YouTube ${kindLabel}. Click Import/Add or Sync to save into AnimaxTube.`);

        for (const r of results) {
          const card = document.createElement('div');
          card.className = 'admin-yt-card';
          const ytUrl =
            searchMode === 'anime'
              ? `https://www.youtube.com/playlist?list=${encodeURIComponent(r.id)}`
              : `https://www.youtube.com/watch?v=${encodeURIComponent(r.id)}`;
          const safeThumb = safeUrl(r.thumbnailUrl);
          card.innerHTML = `
            ${safeThumb ? `<img class="admin-yt-thumb" src="${escapeHtml(safeThumb)}" alt="" loading="lazy" />` : ''}
            <div class="admin-yt-body">
              <a class="admin-yt-item-title" href="${escapeHtml(ytUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title)}</a>
              <div class="admin-yt-item-ch">${escapeHtml(r.channelTitle || r.channelId)}</div>
              <div class="admin-yt-actions"></div>
            </div>
          `;
          const actions = card.querySelector('.admin-yt-actions');

          if (searchMode === 'songs') {
            const typeSel = document.createElement('select');
            typeSel.innerHTML = `
              <option value="op">OP</option>
              <option value="ed">ED</option>
              <option value="ost">OST</option>
            `;
            typeSel.value = r.suggestedSongType || 'ost';
            actions.appendChild(typeSel);

            const addSongBtn = document.createElement('button');
            addSongBtn.type = 'button';
            addSongBtn.className = 'btn-primary';
            addSongBtn.textContent = r.alreadyInDb ? 'In DB (Re-sync)' : 'Add Song';
            addSongBtn.onclick = async () => {
              addSongBtn.disabled = true;
              addSongBtn.textContent = 'Adding…';
              try {
                await adminApi('/api/admin/youtube/import-song', 'POST', {
                  videoId: r.id,
                  title: r.title,
                  channelId: r.channelId,
                  channelTitle: r.channelTitle,
                  songType: typeSel.value,
                  thumbnailUrl: r.thumbnailUrl,
                  publishedAt: r.publishedAt,
                });
                addSongBtn.textContent = '✓ Added';
                setYtStatus(`Added "${r.title}" (${typeSel.value.toUpperCase()})! Refreshing songs…`);
                await loadSongs(false);
              } catch (err) {
                addSongBtn.disabled = false;
                addSongBtn.textContent = 'Add Song';
                setYtStatus(err.message, true);
              }
            };
            actions.appendChild(addSongBtn);

            const addChBtn = document.createElement('button');
            addChBtn.type = 'button';
            addChBtn.className = 'btn-secondary';
            addChBtn.textContent = 'Add & Sync Channel';
            addChBtn.onclick = async () => {
              addChBtn.disabled = true;
              addChBtn.textContent = 'Syncing…';
              try {
                await adminApi('/api/admin/channels', 'POST', {
                  channel: r.channelId,
                  force: true,
                  syncPlaylists: true,
                  syncVideos: true,
                });
                addChBtn.textContent = '✓ Queued';
                setYtStatus(`Added channel "${r.channelTitle}" and queued background sync.`);
              } catch (err) {
                addChBtn.disabled = false;
                addChBtn.textContent = 'Add & Sync Channel';
                setYtStatus(err.message, true);
              }
            };
            actions.appendChild(addChBtn);
          } else if (searchMode === 'videos') {
            const importVidBtn = document.createElement('button');
            importVidBtn.type = 'button';
            importVidBtn.className = 'btn-primary';
            importVidBtn.textContent = r.videoInDb ? 'In DB (Re-import)' : 'Import Video';
            importVidBtn.onclick = async () => {
              importVidBtn.disabled = true;
              importVidBtn.textContent = 'Importing…';
              try {
                const out = await adminApi('/api/admin/youtube/import-video', 'POST', {
                  videoId: r.id,
                  title: r.title,
                  channelId: r.channelId,
                  channelTitle: r.channelTitle,
                  thumbnailUrl: r.thumbnailUrl,
                  publishedAt: r.publishedAt,
                });
                importVidBtn.textContent = '✓ Imported';
                setYtStatus(`Imported video "${r.title}" from ${out.channelName}! Refreshing…`);
                await loadInitialMetadata();
                await loadSeries(false);
              } catch (err) {
                importVidBtn.disabled = false;
                importVidBtn.textContent = 'Import Video';
                setYtStatus(err.message, true);
              }
            };
            actions.appendChild(importVidBtn);

            const syncChBtn = document.createElement('button');
            syncChBtn.type = 'button';
            syncChBtn.className = 'btn-secondary';
            syncChBtn.textContent = r.channelInDb ? 'Sync Channel' : 'Add & Sync Channel';
            syncChBtn.onclick = async () => {
              syncChBtn.disabled = true;
              syncChBtn.textContent = 'Queuing…';
              try {
                await adminApi('/api/admin/channels', 'POST', {
                  channel: r.channelId,
                  force: true,
                  syncPlaylists: true,
                  syncVideos: true,
                });
                syncChBtn.textContent = '✓ Sync Queued';
                setYtStatus(`Channel "${r.channelTitle}" added & background sync queued.`);
              } catch (err) {
                syncChBtn.disabled = false;
                syncChBtn.textContent = r.channelInDb ? 'Sync Channel' : 'Add & Sync Channel';
                setYtStatus(err.message, true);
              }
            };
            actions.appendChild(syncChBtn);
          } else {
            const importPlBtn = document.createElement('button');
            importPlBtn.type = 'button';
            importPlBtn.className = 'btn-primary';
            importPlBtn.textContent = r.playlistInDb ? 'Re-import Playlist' : 'Import Playlist';
            importPlBtn.onclick = async () => {
              importPlBtn.disabled = true;
              importPlBtn.textContent = 'Importing…';
              try {
                const out = await adminApi('/api/admin/youtube/import-playlist', 'POST', {
                  playlistId: r.id,
                  playlistTitle: r.title,
                  channelId: r.channelId,
                  channelTitle: r.channelTitle,
                  thumbnailUrl: r.thumbnailUrl,
                });
                importPlBtn.textContent = `✓ Imported (${out.importedEpisodes})`;
                setYtStatus(`Imported "${r.title}" (${out.importedEpisodes} videos) from ${out.channelName}! Refreshing…`);
                await loadInitialMetadata();
                await loadSeries(false);
              } catch (err) {
                importPlBtn.disabled = false;
                importPlBtn.textContent = 'Import Playlist';
                setYtStatus(err.message, true);
              }
            };
            actions.appendChild(importPlBtn);

            const syncChBtn = document.createElement('button');
            syncChBtn.type = 'button';
            syncChBtn.className = 'btn-secondary';
            syncChBtn.textContent = r.channelInDb ? 'Sync Channel' : 'Add & Sync Channel';
            syncChBtn.onclick = async () => {
              syncChBtn.disabled = true;
              syncChBtn.textContent = 'Queuing…';
              try {
                await adminApi('/api/admin/channels', 'POST', {
                  channel: r.channelId,
                  force: true,
                  syncPlaylists: true,
                  syncVideos: true,
                });
                syncChBtn.textContent = '✓ Sync Queued';
                setYtStatus(`Channel "${r.channelTitle}" added & background sync queued.`);
              } catch (err) {
                syncChBtn.disabled = false;
                syncChBtn.textContent = r.channelInDb ? 'Sync Channel' : 'Add & Sync Channel';
                setYtStatus(err.message, true);
              }
            };
            actions.appendChild(syncChBtn);
          }

          gridNode.appendChild(card);
        }
      } catch (err) {
        setYtStatus(err.message, true);
      } finally {
        searchBtns.forEach((b) => { b.disabled = false; });
      }
    };

    searchBtns.forEach((btn) => {
      btn.addEventListener('click', () => runYtSearch(btn.dataset.ytMode || mode));
    });
  }

  const state = {
    view: 'series',
    region: 'ALL',
    q: '',
    lang: 'all',
    tag: '',
    channelId: null,
    channelName: '',
    sort: 'recent',
    page: 1,
    total: 0,
    isLoadingSeries: false,
    seriesItems: [],
    channels: [],
    topTags: [],
    liveStreams: [],
    unlockedItems: [],
    recommendations: { commentPicks: [], hiddenGems: [] },
    trendingItems: [],
    forYouRows: [],
    showCommentQuotes: true,
    watch: null, // { detail, activeSourceId, activeEpisodeIndex } | { liveStream }
    calendar: {
      weekOffset: 0,
      selectedDayKey: null,
      channelId: '',
      lang: 'all',
      watchlistOnly: false,
      collapsedDays: {},
      expandedLists: {},
      layout: 'week',
      items: [],
      loading: false,
      loadedKey: '',
    },
    saved: loadJson(STORAGE_SAVED, {}),
    history: loadJson(STORAGE_HISTORY, {}),
    songs: {
      group: 'tracks',
      type: 'all',
      q: '',
      channelId: '',
      sort: 'views',
      page: 1,
      total: 0,
      counts: { all: 0, op: 0, ed: 0, ost: 0 },
      items: [],
      groups: [],
      loading: false,
      loadedOnce: false,
    },
    watchReturnView: 'series',
  };

  const el = {
    topbar: document.querySelector('.topbar'),
    sidebar: document.getElementById('sidebar'),
    sidebarBackdrop: document.getElementById('sidebarBackdrop'),
    menuToggleBtn: document.getElementById('menuToggleBtn'),
    brandHomeLink: document.getElementById('brandHomeLink'),
    searchForm: document.getElementById('searchForm'),
    searchInput: document.getElementById('searchInput'),
    clearSearchBtn: document.getElementById('clearSearchBtn'),
    mobileSearchBtn: document.getElementById('mobileSearchBtn'),
    searchBackBtn: document.getElementById('searchBackBtn'),
    regionBadge: document.getElementById('regionBadge'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    aboutStats: document.getElementById('aboutStats'),
    channelsSubtitle: document.getElementById('channelsSubtitle'),
    sidebarChannels: document.getElementById('sidebarChannels'),
    topChipBar: document.getElementById('topChipBar'),
    chipPrevBtn: document.getElementById('chipPrevBtn'),
    chipNextBtn: document.getElementById('chipNextBtn'),
    dynamicTagChips: document.getElementById('dynamicTagChips'),
    sortSelect: document.getElementById('sortSelect'),
    activeFilterBadge: document.getElementById('activeFilterBadge'),
    activeFilterLabel: document.getElementById('activeFilterLabel'),
    clearFiltersBtn: document.getElementById('clearFiltersBtn'),
    trendingShelf: document.getElementById('trendingShelf'),
    trendingShelfGrid: document.getElementById('trendingShelfGrid'),
    forYouShelves: document.getElementById('forYouShelves'),
    gemsShelf: document.getElementById('gemsShelf'),
    gemsShelfGrid: document.getElementById('gemsShelfGrid'),
    liveShelf: document.getElementById('liveShelf'),
    liveShelfGrid: document.getElementById('liveShelfGrid'),
    unlockedShelf: document.getElementById('unlockedShelf'),
    unlockedShelfGrid: document.getElementById('unlockedShelfGrid'),
    recsShelf: document.getElementById('recsShelf'),
    recsShelfGrid: document.getElementById('recsShelfGrid'),
    toggleCommentsCheckbox: document.getElementById('toggleCommentsCheckbox'),
    seriesCountLine: document.getElementById('seriesCountLine'),
    seriesGrid: document.getElementById('seriesGrid'),
    seriesPagination: document.getElementById('seriesPagination'),
    loadMoreSentinel: document.getElementById('loadMoreSentinel'),
    loadMoreStatus: document.getElementById('loadMoreStatus'),
    loadMoreBtn: document.getElementById('loadMoreBtn'),
    channelsGrid: document.getElementById('channelsGrid'),
    savedGrid: document.getElementById('savedGrid'),
    historyGrid: document.getElementById('historyGrid'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
    views: {
      series: document.getElementById('seriesView'),
      calendar: document.getElementById('calendarView'),
      songs: document.getElementById('songsView'),
      channels: document.getElementById('channelsView'),
      watchlist: document.getElementById('watchlistView'),
      history: document.getElementById('historyView'),
      watch: document.getElementById('watchView'),
      about: document.getElementById('aboutView'),
    },
    songsTypeChips: document.getElementById('songsTypeChips'),
    songsLayoutGroup: document.getElementById('songsLayoutGroup'),
    songsSearchInput: document.getElementById('songsSearchInput'),
    songsChannelSelect: document.getElementById('songsChannelSelect'),
    songsSortSelect: document.getElementById('songsSortSelect'),
    songsCountLine: document.getElementById('songsCountLine'),
    songsGrid: document.getElementById('songsGrid'),
    songsPagination: document.getElementById('songsPagination'),
    songsLoadMoreBtn: document.getElementById('songsLoadMoreBtn'),
    calendarTimezoneBadge: document.getElementById('calendarTimezoneBadge'),
    calPrevWeekBtn: document.getElementById('calPrevWeekBtn'),
    calTodayBtn: document.getElementById('calTodayBtn'),
    calNextWeekBtn: document.getElementById('calNextWeekBtn'),
    calWeekRangeLabel: document.getElementById('calWeekRangeLabel'),
    calChannelSelect: document.getElementById('calChannelSelect'),
    calLangGroup: document.getElementById('calLangGroup'),
    calWatchlistBtn: document.getElementById('calWatchlistBtn'),
    calToggleSectionsBtn: document.getElementById('calToggleSectionsBtn'),
    calLayoutGroup: document.getElementById('calLayoutGroup'),
    calDayTabs: document.getElementById('calDayTabs'),
    calendarGrid: document.getElementById('calendarGrid'),
    playerFrame: document.getElementById('playerFrame'),
    geoLockCard: document.getElementById('geoLockCard'),
    licensorBanner: document.getElementById('licensorBanner'),
    legalChannelList: document.getElementById('legalChannelList'),
    backToBrowseBtn: document.getElementById('backToBrowseBtn'),
    saveSeriesBtn: document.getElementById('saveSeriesBtn'),
    watchSeriesTitle: document.getElementById('watchSeriesTitle'),
    watchEpisodeTitle: document.getElementById('watchEpisodeTitle'),
    watchChannelMeta: document.getElementById('watchChannelMeta'),
    watchLikePill: document.getElementById('watchLikePill'),
    watchViewPill: document.getElementById('watchViewPill'),
    sourceSwitcher: document.getElementById('sourceSwitcher'),
    watchDescBox: document.getElementById('watchDescBox'),
    watchDescStats: document.getElementById('watchDescStats'),
    watchDescTags: document.getElementById('watchDescTags'),
    watchSynopsis: document.getElementById('watchSynopsis'),
    watchEpDescription: document.getElementById('watchEpDescription'),
    watchBuzzQuote: document.getElementById('watchBuzzQuote'),
    toggleDescBtn: document.getElementById('toggleDescBtn'),
    episodeQueuePanel: document.getElementById('episodeQueuePanel'),
    queueSubInfo: document.getElementById('queueSubInfo'),
    autoNextCheckbox: document.getElementById('autoNextCheckbox'),
    episodeList: document.getElementById('episodeList'),
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }

  function getActiveTheme() {
    if (document.documentElement.dataset.theme === 'light') return 'light';
    if (document.documentElement.dataset.theme === 'dark') return 'dark';
    const saved = (() => {
      try {
        return localStorage.getItem(STORAGE_THEME);
      } catch {
        return null;
      }
    })();
    if (saved === 'light' || saved === 'dark') return saved;
    const prefersLight =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }

  function applyTheme(theme, persist = false) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute('content', next === 'light' ? '#ffffff' : '#000000');
    }
    if (el.themeToggleBtn) {
      const label = next === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
      el.themeToggleBtn.setAttribute('aria-label', label);
      el.themeToggleBtn.setAttribute('title', label);
      el.themeToggleBtn.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
    }
    if (persist) {
      try {
        localStorage.setItem(STORAGE_THEME, next);
      } catch {
        /* ignore */
      }
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(raw) {
    if (!raw) return '';
    const trimmed = String(raw).trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return parsed.href;
      }
    } catch {
      /* ignore invalid URLs */
    }
    return '';
  }

  function formatViews(n) {
    if (!n || n <= 0) return null;
    return `${compactFmt.format(n)} views`;
  }

  function formatCompact(n) {
    if (!n || n <= 0) return '0';
    return compactFmt.format(n);
  }

  function formatRelativeDate(unixSec) {
    if (!unixSec) return null;
    const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
    if (diffSec < 3600) return `${Math.max(1, Math.floor(diffSec / 60))}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    const days = Math.floor(diffSec / 86400);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? '' : 's'} ago`;
  }

  function formatFullDate(unixSec) {
    if (!unixSec) return '';
    return new Date(unixSec * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function formatDuration(iso) {
    if (!iso) return '';
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return '';
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseInt(m[3] || '0', 10);
    if (h > 0) return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${min}:${String(s).padStart(2, '0')}`;
  }

  function formatLangBadge(lang) {
    if (lang === 'zh-Hant') return { label: '繁中', cls: 'zh' };
    if (lang === 'zh-Hans') return { label: '简中', cls: 'zh' };
    if (lang === 'multi') return { label: 'EN/中文', cls: 'multi' };
    return { label: 'EN', cls: 'en' };
  }

  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  }

  function apiUrl(base, extraParams = {}) {
    const params = new URLSearchParams(extraParams);
    if (state.region && state.region !== 'ALL') {
      params.set('region', state.region);
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  function setRegionBadge(code) {
    if (!el.regionBadge) return;
    const label = !code || code === 'ALL' ? 'Global' : code;
    el.regionBadge.textContent = label;
    el.regionBadge.title = `Auto-detected geo region: ${label}`;
  }

  async function detectInitialRegion() {
    try {
      localStorage.removeItem(STORAGE_REGION);
    } catch {
      /* ignore */
    }

    try {
      const serverGeo = await fetchJson('/api/geo');
      if (serverGeo.region) {
        setRegionBadge(serverGeo.region);
        return serverGeo.region;
      }
    } catch {
      /* ignore */
    }

    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (TIMEZONE_TO_REGION[tz]) {
        setRegionBadge(TIMEZONE_TO_REGION[tz]);
        return TIMEZONE_TO_REGION[tz];
      }
      if (tz.startsWith('America/')) {
        const ca = tz.includes('Toronto') || tz.includes('Vancouver') || tz.includes('Edmonton') || tz.includes('Montreal');
        const code = ca ? 'CA' : 'US';
        setRegionBadge(code);
        return code;
      }
    } catch {
      /* ignore */
    }

    const locale = (navigator.language || '').split('-')[1]?.toUpperCase();
    if (locale && /^[A-Z]{2}$/.test(locale)) {
      setRegionBadge(locale);
      return locale;
    }

    setRegionBadge('ALL');
    return 'ALL';
  }

  function isOverlaySidebarViewport() {
    return window.innerWidth < 1280;
  }

  function setSidebarOpen(open) {
    if (!el.sidebar) return;
    if (isOverlaySidebarViewport()) {
      el.sidebar.classList.remove('mini');
      el.sidebar.classList.toggle('collapsed', !open);
      if (el.sidebarBackdrop) {
        el.sidebarBackdrop.hidden = !open;
      }
    } else {
      el.sidebar.classList.remove('collapsed');
      el.sidebar.classList.toggle('mini', !open);
      if (el.sidebarBackdrop) {
        el.sidebarBackdrop.hidden = true;
      }
    }
  }

  function switchView(view) {
    const prevView = state.view;
    if (prevView === 'watch' && view !== 'watch') {
      window.AnimaxPlayer.stopVideo();
      if (view === 'series') loadForYou().then(renderHomeShelves);
    }
    state.view = view;
    for (const [key, node] of Object.entries(el.views)) {
      if (node) node.hidden = key !== view;
    }
    document.querySelectorAll('.nav-item, .mobile-nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    if (isOverlaySidebarViewport()) {
      setSidebarOpen(false);
    }
    if (view === 'watchlist') renderWatchlist();
    if (view === 'history') renderHistory();
    if (view === 'channels') renderChannelsGrid();
    if (view === 'songs') {
      renderSongsChannelOptions();
      if (!state.songs.loadedOnce) loadSongs(false);
    }
    if (view === 'calendar') {
      renderCalendarChannelOptions();
      loadCalendar();
      startCalendarCountdownTicker();
    } else {
      stopCalendarCountdownTicker();
    }
    if (view === 'about') renderLegalChannels();
    if (view === 'series') {
      requestAnimationFrame(updateChipScrollButtons);
    }
    if (view !== 'watch') {
      setDocumentTitle(VIEW_TITLES[view]);
      if (prevView !== view) window.scrollTo(0, 0);
    }
  }

  const VIEW_PATHS = {
    series: '/',
    calendar: '/calendar',
    songs: '/songs',
    channels: '/channels',
    watchlist: '/watchlist',
    history: '/history',
    about: '/about',
  };

  async function loadInitialMetadata() {
    const shelfFetchLimit = String(getShelfLimit() + 4);
    const [health, chData, tagsData, liveData, unlockedData, recsData, trendingData] = await Promise.all([
      fetchJson(apiUrl('/api/health')),
      fetchJson(apiUrl('/api/channels')),
      fetchJson(apiUrl('/api/tags', { limit: '18' })),
      fetchJson(apiUrl('/api/live')),
      fetchJson(apiUrl('/api/unlocked', { limit: shelfFetchLimit })),
      fetchJson(apiUrl('/api/recommendations')),
      fetchJson(apiUrl('/api/trending', { limit: shelfFetchLimit })).catch(() => ({ items: [] })),
    ]);
    state.channels = chData.channels || [];
    state.topTags = tagsData.tags || [];
    state.liveStreams = liveData.streams || [];
    state.unlockedItems = unlockedData.items || [];
    state.recommendations = recsData || { commentPicks: [], hiddenGems: [] };
    state.trendingItems = trendingData.items || [];
    await loadForYou();

    if (state.channelId) {
      const selected = state.channels.find((c) => c.id === state.channelId);
      if (!selected || selected.seriesCount === 0) {
        state.channelId = null;
        state.channelName = '';
      }
    }

    const geoLabel = state.region && state.region !== 'ALL' ? ` (${state.region})` : ' (Global)';
    const liveNote = health.liveCount > 0 ? ` · ${health.liveCount} LIVE` : '';
    if (el.aboutStats) {
      el.aboutStats.textContent = `${health.channels} channels · ${health.series} series${liveNote}${geoLabel}`;
    }
    if (el.channelsSubtitle) {
      el.channelsSubtitle.textContent =
        state.region && state.region !== 'ALL'
          ? `Showing video & series counts playable in ${state.region}. Channels licensed for a different territory show 0.`
          : 'Licensed distributors publishing English- and Chinese-subtitled anime & donghua on their official YouTube channels (members-only content excluded).';
    }
    if (state.view === 'about') renderLegalChannels();
    renderSidebarChannels();
    renderCalendarChannelOptions();
    renderSongsChannelOptions();
    renderDynamicTags();
    renderHomeShelves();
    if (state.view === 'channels') renderChannelsGrid();
    if (state.view === 'calendar') loadCalendar(true);
    if (state.view === 'songs') loadSongs(false);
  }

  function renderSidebarChannels() {
    el.sidebarChannels.innerHTML = state.channels
      .map((c) => {
        const active = state.channelId === c.id ? ' active' : '';
        const unavailable = c.seriesCount === 0 ? ' geo-unavailable' : '';
        const avatarUrl = safeUrl(c.avatarUrl);
        return `
          <button class="sidebar-ch-btn${active}${unavailable}" data-channel-id="${c.id}" data-channel-name="${escapeHtml(c.name)}" ${c.seriesCount === 0 ? 'disabled title="Not available in your geo"' : ''}>
            <span class="sidebar-ch-left">
              ${avatarUrl ? `<img class="sidebar-ch-avatar" src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" />` : `<span class="sidebar-ch-avatar"></span>`}
              <span class="sidebar-ch-name">${escapeHtml(c.name)}</span>
            </span>
            <span class="sidebar-ch-count">${c.seriesCount}</span>
          </button>
        `;
      })
      .join('');
  }

  function renderDynamicTags() {
    el.dynamicTagChips.innerHTML = state.topTags
      .map((t) => {
        const active = state.tag === t.tag ? ' active' : '';
        return `<button class="chip${active}" data-lang="" data-tag="${escapeHtml(t.tag)}">${escapeHtml(t.tag)}</button>`;
      })
      .join('');
    requestAnimationFrame(updateChipScrollButtons);
  }

  function toSavedEntry(series, channels) {
    return {
      slug: series.slug,
      canonicalTitle: series.canonicalTitle,
      titleEn: series.titleEn,
      titleZh: series.titleZh,
      titleRomaji: series.titleRomaji,
      posterUrl: series.posterUrl,
      episodeCount: series.episodeCount,
      totalViews: series.totalViews,
      latestUploadedAt: series.latestUploadedAt,
      tags: series.tags,
      subLanguages: series.subLanguages,
      channels,
    };
  }

  function renderHomeShelves() {
    const isCleanHome = !state.q && state.lang === 'all' && !state.tag && !state.channelId;

    // 1. Live Streams shelf
    if (isCleanHome && state.liveStreams.length > 0) {
      el.liveShelf.hidden = false;
      el.liveShelfGrid.innerHTML = state.liveStreams
        .map((ls) => {
          const isLive = ls.status === 'live';
          const viewers = ls.concurrentViewers > 0 ? `${formatCompact(ls.concurrentViewers)} watching` : 'Live stream';
          const thumbUrl = safeUrl(optimizeThumbUrl(ls.thumbnail_url));
          const avatarUrl = safeUrl(ls.channel_avatar);
          return `
            <article class="series-card live-card" data-live-vid="${escapeHtml(ls.youtube_video_id)}">
              <div class="series-thumb">
                ${thumbUrl ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(ls.title)}" loading="lazy" decoding="async" />` : ''}
                <span class="thumb-badge-live">${isLive ? '● LIVE' : 'UPCOMING'}</span>
                ${PLAY_OVERLAY}
              </div>
              <div class="yt-card-meta">
                ${avatarUrl ? `<img class="yt-card-avatar" src="${escapeHtml(avatarUrl)}" alt="" />` : `<span class="yt-card-avatar"></span>`}
                <div class="yt-card-text">
                  <h3 class="series-title">${escapeHtml(ls.title)}</h3>
                  <div class="yt-card-channel">${escapeHtml(ls.channel_name)} <span class="verified-icon">✓</span></div>
                  <div class="yt-card-stats">${escapeHtml(viewers)}</div>
                </div>
              </div>
            </article>
          `;
        })
        .join('');
    } else {
      el.liveShelf.hidden = true;
    }

    const shelfLimit = getShelfLimit();

    // Discovery shelves: each series shows once across shelves (in this order) and watched series are hidden.
    const seen = new Set(Object.keys(state.history));
    const takeUnseen = (items, limit = shelfLimit) => {
      const out = [];
      for (const it of items || []) {
        if (out.length >= limit) break;
        if (seen.has(it.slug)) continue;
        seen.add(it.slug);
        out.push(it);
      }
      return out;
    };

    fillShelf(el.unlockedShelf, el.unlockedShelfGrid, isCleanHome ? takeUnseen(state.unlockedItems) : [], { badge: 'New' });
    fillShelf(el.trendingShelf, el.trendingShelfGrid, isCleanHome ? takeUnseen(state.trendingItems) : []);

    el.forYouShelves.innerHTML = isCleanHome
      ? state.forYouRows
          .map((row) => ({ row, items: takeUnseen(row.items) }))
          .filter(({ items }) => items.length >= 3)
          .map(
            ({ row, items }) => `
              <section class="home-shelf">
                <div class="shelf-header">
                  <div>
                    <h2 class="shelf-title">Because you watched ${escapeHtml(row.seed.canonicalTitle)}</h2>
                    <p class="shelf-sub">Similar genres, tags and viewer buzz</p>
                  </div>
                </div>
                <div class="shelf-row">${items.map((it) => renderSeriesCard(it)).join('')}</div>
              </section>
            `
          )
          .join('')
      : '';

    fillShelf(el.recsShelf, el.recsShelfGrid, isCleanHome ? takeUnseen(state.recommendations.commentPicks) : [], {
      showQuote: state.showCommentQuotes,
    });
    fillShelf(el.gemsShelf, el.gemsShelfGrid, isCleanHome ? takeUnseen(state.recommendations.hiddenGems) : [], {
      showQuote: state.showCommentQuotes,
    });
  }

  async function loadForYou() {
    const seeds = getHistoryList()
      .slice(0, 5)
      .map((h) => h.series.slug);
    if (seeds.length === 0) {
      state.forYouRows = [];
      return;
    }
    const exclude = [...new Set([...Object.keys(state.history), ...Object.keys(state.saved)])].slice(0, 150);
    try {
      const data = await fetchJson(apiUrl('/api/recommendations/for-you', { seeds: seeds.join(','), exclude: exclude.join(',') }));
      state.forYouRows = data.rows || [];
    } catch {
      state.forYouRows = [];
    }
  }

  function fillShelf(shelf, grid, items, cardOpts = {}) {
    shelf.hidden = items.length === 0;
    grid.innerHTML = items.map((item) => renderSeriesCard(item, cardOpts)).join('');
  }

  function getHistoryList() {
    return Object.values(state.history).sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
  }

  async function loadSeries(append = false) {
    if (!append) {
      state.page = 1;
      if (seriesAbortCtrl) seriesAbortCtrl.abort();
      seriesAbortCtrl = new AbortController();
    } else if (state.isLoadingSeries) {
      return;
    }

    const ctrl = !append ? seriesAbortCtrl : null;
    state.isLoadingSeries = true;
    if (!append) {
      el.seriesGrid.classList.add('is-loading');
    } else if (el.loadMoreStatus) {
      el.loadMoreStatus.textContent = 'Loading more series…';
    }

    const extra = {
      lang: state.lang,
      sort: state.sort,
      page: String(state.page),
      limit: String(getPageLimit()),
    };
    if (state.q) extra.q = state.q;
    if (state.tag) extra.tag = state.tag;
    if (state.channelId) extra.channel = String(state.channelId);

    try {
      const data = await fetchJson(apiUrl('/api/series', extra), ctrl ? { signal: ctrl.signal } : {});
      state.total = data.total || 0;
      state.seriesItems = append ? [...state.seriesItems, ...(data.items || [])] : data.items || [];
      if (!append) {
        renderHomeShelves();
      }
      renderSeriesGrid();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      throw err;
    } finally {
      if (!ctrl || seriesAbortCtrl === ctrl) {
        state.isLoadingSeries = false;
        el.seriesGrid.classList.remove('is-loading');
      }
    }
  }

  function registerSeriesItem(item) {
    if (item && item.slug) {
      seriesCatalog.set(item.slug, item);
    }
  }

  function renderSeriesCard(item, opts = {}) {
    registerSeriesItem(item);
    const primaryCh = (item.channels && item.channels[0]) || null;
    const extraChCount = (item.channels || []).length > 1 ? ` +${item.channels.length - 1}` : '';
    const dur = formatDuration(item.firstDurationIso);
    const epsBadge = dur ? `${item.episodeCount} eps · ${dur}` : `${item.episodeCount} eps`;

    const viewsText = formatViews(item.totalViews);
    const dateText = formatRelativeDate(item.latestUploadedAt);
    const statsParts = [viewsText, dateText].filter(Boolean);
    const statsLine = statsParts.length > 0 ? statsParts.join(' · ') : `${item.episodeCount} episodes`;

    const langBadges = (item.subLanguages || [])
      .slice(0, 2)
      .map((l) => {
        const b = formatLangBadge(l);
        return `<span class="lang-tag ${b.cls}">${escapeHtml(b.label)}</span>`;
      })
      .join('');

    const quoteHtml =
      opts.showQuote && item.topCommentQuote
        ? `<div class="comment-quote-pill">"${escapeHtml(item.topCommentQuote)}"</div>`
        : '';

    const isSaved = Boolean(state.saved[item.slug]);
    const rawPoster = safeUrl(item.posterUrl);
    const thumbSrc = safeUrl(optimizeThumbUrl(rawPoster));
    const fallbackAttr =
      rawPoster && thumbSrc && thumbSrc !== rawPoster
        ? ` data-fallback-src="${escapeHtml(rawPoster)}"`
        : '';
    const primaryAvatar = safeUrl(primaryCh?.channelAvatar);

    const removeBtnHtml = opts.removable
      ? `<button type="button" class="card-action-btn card-remove-btn" data-remove-history="${escapeHtml(item.slug)}" aria-label="Remove from history" title="Remove from history">${REMOVE_ICON}</button>`
      : '';

    return `
      <article class="series-card" data-slug="${escapeHtml(item.slug)}">
        <div class="series-thumb">
          ${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}"${fallbackAttr} alt="${escapeHtml(item.canonicalTitle)}" loading="lazy" decoding="async" />` : ''}
          <div class="thumb-badge-langs">${langBadges}</div>
          <div class="card-thumb-actions">
            <button type="button" class="card-action-btn card-watchlist-btn${isSaved ? ' saved' : ''}" data-watchlist-toggle="${escapeHtml(item.slug)}" aria-label="${isSaved ? 'Remove from Watchlist' : 'Add to Watchlist'}" aria-pressed="${isSaved ? 'true' : 'false'}" title="${isSaved ? 'In Watchlist' : 'Add to Watchlist'}">
              ${isSaved ? BOOKMARK_FILLED_ICON : BOOKMARK_OUTLINE_ICON}
            </button>
            ${removeBtnHtml}
          </div>
          ${opts.badge ? `<span class="thumb-badge-unlock">${escapeHtml(opts.badge)}</span>` : ''}
          <span class="thumb-badge-eps">${escapeHtml(epsBadge)}</span>
          ${PLAY_OVERLAY}
        </div>
        <div class="yt-card-meta">
          ${primaryAvatar ? `<img class="yt-card-avatar" src="${escapeHtml(primaryAvatar)}" alt="" loading="lazy" decoding="async" />` : `<span class="yt-card-avatar"></span>`}
          <div class="yt-card-text">
            <h3 class="series-title">${escapeHtml(item.canonicalTitle)}</h3>
            <div class="yt-card-channel">
              <span>${escapeHtml((primaryCh?.channelName || 'Official Channel') + extraChCount)}</span>
              <span class="verified-icon" title="Verified Channel">✓</span>
            </div>
            <div class="yt-card-stats">${escapeHtml(statsLine)}</div>
            ${quoteHtml}
          </div>
        </div>
      </article>
    `;
  }

  function renderSeriesGrid() {
    const activeLabels = [];
    if (state.channelId) activeLabels.push(`Channel: ${state.channelName}`);
    if (state.tag) activeLabels.push(`#${state.tag}`);
    el.activeFilterBadge.hidden = activeLabels.length === 0;
    el.activeFilterLabel.textContent = activeLabels.join(' · ');

    const filterNote = state.q ? ` matching "${state.q}"` : '';
    el.seriesCountLine.textContent = `${state.seriesItems.length} of ${state.total} series${filterNote}`;

    if (state.seriesItems.length === 0) {
      el.seriesGrid.innerHTML = `<div class="empty-state">No series matched your current filters.</div>`;
    } else {
      el.seriesGrid.innerHTML = state.seriesItems.map((it) => renderSeriesCard(it)).join('');
    }
    if (state.q) {
      maybeMountAdminYtSearch(el.seriesGrid, 'anime', state.q, state.seriesItems.length > 0);
    }
    const hasMore = state.seriesItems.length < state.total;
    el.seriesPagination.hidden = !hasMore;
    if (el.loadMoreSentinel) el.loadMoreSentinel.hidden = !hasMore || !loadMoreObserver;
    if (el.loadMoreBtn) el.loadMoreBtn.hidden = !hasMore || Boolean(loadMoreObserver);
  }

  function renderChannelsGrid() {
    if (state.channels.length === 0) {
      el.channelsGrid.innerHTML = `<div class="empty-state">No channels discovered yet.</div>`;
      return;
    }
    el.channelsGrid.innerHTML = state.channels
      .map((ch) => {
        const langBadges = (ch.subLanguages || [])
          .map((l) => {
            const b = formatLangBadge(l);
            return `<span class="lang-tag ${b.cls}">${escapeHtml(b.label)}</span>`;
          })
          .join('');
        const isUnavailable = ch.seriesCount === 0 || ch.totalEpisodes === 0;
        const geoNote = isUnavailable && state.region && state.region !== 'ALL'
          ? `<span class="ch-pill">Different geo${ch.regionFocus ? `: ${escapeHtml(ch.regionFocus)}` : ''}</span>`
          : '';
        const chAvatar = safeUrl(ch.avatarUrl);
        const chUrl = safeUrl(ch.url);
        return `
          <article class="channel-card${isUnavailable ? ' geo-unavailable' : ''}">
            <div>
              <div class="channel-card-top">
                ${chAvatar ? `<img class="channel-card-avatar" src="${escapeHtml(chAvatar)}" alt="" loading="lazy" />` : `<span class="channel-card-avatar"></span>`}
                <div>
                  <h2 class="channel-card-title">${escapeHtml(ch.name)}</h2>
                  <div class="channel-card-handle">${escapeHtml(ch.handle || ch.youtubeChannelId)}</div>
                </div>
              </div>
              <p class="channel-card-desc">${escapeHtml(ch.description || '')}</p>
            </div>
            <div class="channel-card-meta">
              ${langBadges}
              <span class="ch-pill">${ch.seriesCount} series</span>
              <span class="ch-pill">${ch.totalEpisodes} videos</span>
              ${geoNote}
            </div>
            <div class="channel-card-actions">
              <button class="btn-primary browse-ch-btn" data-channel-id="${ch.id}" data-channel-name="${escapeHtml(ch.name)}" ${isUnavailable ? 'disabled' : ''}>Browse Series</button>
              ${chUrl ? `<a class="btn-secondary" href="${escapeHtml(chUrl)}" target="_blank" rel="noopener noreferrer">YouTube ↗</a>` : ''}
            </div>
          </article>
        `;
      })
      .join('');
  }

  let calendarCountdownTimer = null;
  let calendarAbortCtrl = null;
  const calendarItemsById = new Map();

  function getLocalDayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getUserTimeZoneLabel() {
    const tzName = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch {
        return '';
      }
    })();
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    const utcStr = `UTC${sign}${hh}:${mm}`;
    return tzName ? `${tzName} (${utcStr})` : utcStr;
  }

  function getLocalWeekInfo(weekOffset) {
    const now = new Date();
    const todayKey = getLocalDayKey(now);
    const mondayOffset = (now.getDay() + 6) % 7; // Mon=0..Sun=6
    const startDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - mondayOffset + weekOffset * 7,
      0,
      0,
      0,
      0
    );
    const endDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate() + 7,
      0,
      0,
      0,
      0
    );
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i, 0, 0, 0, 0);
      days.push({
        key: getLocalDayKey(d),
        date: d,
        isToday: getLocalDayKey(d) === todayKey,
        weekdayShort: d.toLocaleDateString(undefined, { weekday: 'short' }),
        weekdayLong: d.toLocaleDateString(undefined, { weekday: 'long' }),
        dateShort: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      });
    }
    return {
      todayKey,
      days,
      startSec: Math.floor(startDate.getTime() / 1000),
      endSec: Math.floor(endDate.getTime() / 1000),
      rangeLabel: `${days[0].dateShort} – ${days[6].dateShort}, ${days[6].date.getFullYear()}`,
    };
  }

  function formatLocalClockTime(unixSec) {
    return new Date(unixSec * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatCalendarCountdown(unixSec, status) {
    if (status === 'live') return 'LIVE NOW';
    const nowSec = Math.floor(Date.now() / 1000);
    const diff = unixSec - nowSec;
    if (status === 'released') return 'Watch now';
    if (diff <= 0) return diff > -900 ? 'Dropping now' : 'Expected soon';
    if (diff < 3600) return `in ${Math.max(1, Math.ceil(diff / 60))}m`;
    if (diff < 86400) {
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
    }
    const d = Math.floor(diff / 86400);
    const h = Math.floor((diff % 86400) / 3600);
    return h > 0 ? `in ${d}d ${h}h` : `in ${d}d`;
  }

  function isCalendarSectionCollapsed(dayKey, itemCount) {
    const override = state.calendar.collapsedDays[dayKey];
    if (typeof override === 'boolean') return override;
    return itemCount === 0;
  }

  function toggleCalendarSection(dayKey, itemCount) {
    if (!dayKey) return;
    state.calendar.collapsedDays[dayKey] = !isCalendarSectionCollapsed(dayKey, itemCount);
    renderCalendarView();
  }

  function syncCalendarToggleSectionsButton(daysToRender, byDay) {
    if (!el.calToggleSectionsBtn) return;
    const allCollapsed =
      daysToRender.length > 0 &&
      daysToRender.every((d) => isCalendarSectionCollapsed(d.key, (byDay.get(d.key) || []).length));
    const label = allCollapsed ? 'Show all day sections' : 'Hide all day sections';
    el.calToggleSectionsBtn.classList.toggle('active', allCollapsed);
    el.calToggleSectionsBtn.setAttribute('aria-pressed', allCollapsed ? 'true' : 'false');
    el.calToggleSectionsBtn.setAttribute('aria-label', label);
    el.calToggleSectionsBtn.title = label;
  }

  function startCalendarCountdownTicker() {
    if (calendarCountdownTimer) return;
    calendarCountdownTimer = setInterval(() => {
      if (state.view !== 'calendar' || !el.calendarGrid) return;
      el.calendarGrid.querySelectorAll('[data-countdown-ts]').forEach((node) => {
        const ts = parseInt(node.dataset.countdownTs, 10);
        const status = node.dataset.countdownStatus || 'upcoming';
        if (Number.isFinite(ts)) {
          node.textContent = formatCalendarCountdown(ts, status);
        }
      });
    }, 30_000);
  }

  function stopCalendarCountdownTicker() {
    if (calendarCountdownTimer) {
      clearInterval(calendarCountdownTimer);
      calendarCountdownTimer = null;
    }
  }

  function renderCalendarChannelOptions() {
    if (!el.calChannelSelect) return;
    const current = state.calendar.channelId || '';
    const available = state.channels.filter((c) => c.seriesCount > 0);
    el.calChannelSelect.innerHTML = [
      '<option value="">All YT Channels</option>',
      ...available.map(
        (c) => `<option value="${c.id}"${String(c.id) === String(current) ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
      ),
    ].join('');
  }

  async function loadCalendar(force = false) {
    if (!el.calendarGrid) return;
    const week = getLocalWeekInfo(state.calendar.weekOffset);
    const queryKey = [
      state.region,
      week.startSec,
      week.endSec,
      state.calendar.channelId,
      state.calendar.lang,
    ].join('|');

    if (el.calendarTimezoneBadge) {
      el.calendarTimezoneBadge.textContent = getUserTimeZoneLabel();
    }
    if (el.calWeekRangeLabel) {
      el.calWeekRangeLabel.textContent = week.rangeLabel;
    }

    if (!force && state.calendar.loadedKey === queryKey && !state.calendar.loading) {
      renderCalendarView();
      return;
    }

    if (calendarAbortCtrl) calendarAbortCtrl.abort();
    calendarAbortCtrl = new AbortController();
    const ctrl = calendarAbortCtrl;
    state.calendar.loading = true;
    el.calendarGrid.innerHTML = `<div class="empty-state">Loading YouTube release schedule…</div>`;

    const params = {
      start: String(week.startSec),
      end: String(week.endSec),
      lang: state.calendar.lang,
    };
    if (state.calendar.channelId) params.channel = String(state.calendar.channelId);

    try {
      const data = await fetchJson(apiUrl('/api/calendar', params), { signal: ctrl.signal });
      state.calendar.items = data.items || [];
      state.calendar.loadedKey = queryKey;
      renderCalendarView();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      el.calendarGrid.innerHTML = `<div class="empty-state">Failed to load calendar schedule.</div>`;
    } finally {
      if (calendarAbortCtrl === ctrl) {
        state.calendar.loading = false;
      }
    }
  }

  function renderCalendarCard(item) {
    calendarItemsById.set(item.id, item);
    if (item.seriesSlug) {
      registerSeriesItem({
        slug: item.seriesSlug,
        canonicalTitle: item.seriesTitle,
        posterUrl: item.posterUrl || item.thumbnailUrl,
        episodeCount: item.episodeNumber || 1,
        totalViews: 0,
        latestUploadedAt: item.airingAt,
        tags: [],
        subLanguages: [item.subLanguage],
        channels: [
          {
            channelId: item.channelId,
            channelName: item.channelName,
            channelAvatar: item.channelAvatar,
            subLanguage: item.subLanguage,
          },
        ],
      });
    }

    const langBadge = formatLangBadge(item.subLanguage);
    const thumbSrc = safeUrl(optimizeThumbUrl(item.thumbnailUrl || item.posterUrl));
    const avatarSrc = safeUrl(item.channelAvatar);
    const isSaved = item.seriesSlug ? Boolean(state.saved[item.seriesSlug]) : false;
    const epBadge =
      item.batchCount > 1
        ? item.episodeNumber !== null && item.episodeNumberEnd != null
          ? `EP ${item.episodeNumber}–${item.episodeNumberEnd}`
          : `${item.batchCount} EPs`
        : item.episodeNumber !== null
          ? `EP ${item.episodeNumber}`
          : item.kind === 'premiere'
            ? item.status === 'live'
              ? 'LIVE'
              : 'Premiere'
            : 'New EP';

    let statusPill = '';
    if (item.status === 'live') {
      statusPill = `<span class="cal-status-pill live">● LIVE</span>`;
    } else if (item.status === 'released') {
      statusPill = `<span class="cal-status-pill released">Watch</span>`;
    } else if (item.confidence === 'exact') {
      statusPill = `<span class="cal-status-pill exact">Premiere</span>`;
    } else {
      statusPill = `<span class="cal-status-pill estimated" title="Predicted from channel's weekly YouTube upload schedule">~Weekly</span>`;
    }

    const countdownText = formatCalendarCountdown(item.airingAt, item.status);
    const localTimeText = formatLocalClockTime(item.airingAt);

    return `
      <article class="cal-card ${escapeHtml(item.status)}" data-cal-id="${escapeHtml(item.id)}">
        <div class="cal-card-top">
          <div class="cal-time-wrap">
            <span class="cal-time">${escapeHtml(localTimeText)}</span>
            <span class="cal-countdown ${escapeHtml(item.status)}" data-countdown-ts="${item.airingAt}" data-countdown-status="${escapeHtml(item.status)}">${escapeHtml(countdownText)}</span>
          </div>
          ${statusPill}
        </div>
        <div class="cal-card-body">
          <div class="cal-thumb">
            ${thumbSrc ? `<img src="${escapeHtml(thumbSrc)}" alt="${escapeHtml(item.seriesTitle)}" loading="lazy" decoding="async" />` : ''}
            <span class="cal-ep-badge">${escapeHtml(epBadge)}</span>
          </div>
          <div class="cal-info">
            <h3 class="cal-series-title">${escapeHtml(item.seriesTitle)}</h3>
            ${item.episodeTitle && item.episodeTitle !== item.seriesTitle ? `<div class="cal-ep-title">${escapeHtml(item.episodeTitle)}</div>` : ''}
            <div class="cal-channel-row">
              ${avatarSrc ? `<img class="cal-ch-avatar" src="${escapeHtml(avatarSrc)}" alt="" loading="lazy" />` : ''}
              <span class="cal-ch-name">${escapeHtml(item.channelName)}</span>
              <span class="lang-tag ${langBadge.cls}">${escapeHtml(langBadge.label)}</span>
            </div>
          </div>
        </div>
        ${
          item.seriesSlug
            ? `<div class="cal-card-actions">
                 <button type="button" class="cal-action-btn cal-watchlist-btn${isSaved ? ' saved' : ''}" data-watchlist-toggle="${escapeHtml(item.seriesSlug)}" aria-pressed="${isSaved ? 'true' : 'false'}" aria-label="${isSaved ? 'Remove from Watchlist' : 'Add to Watchlist'}" title="${isSaved ? 'In Watchlist' : 'Add to Watchlist'}">${isSaved ? BOOKMARK_FILLED_ICON : BOOKMARK_OUTLINE_ICON}</button>
               </div>`
            : ''
        }
      </article>
    `;
  }

  function renderCalendarView() {
    if (!el.calendarGrid || !el.calDayTabs) return;
    const week = getLocalWeekInfo(state.calendar.weekOffset);
    const filteredItems = state.calendar.items.filter((it) => {
      if (state.calendar.watchlistOnly) {
        return Boolean(it.seriesSlug && state.saved[it.seriesSlug]);
      }
      return true;
    });

    const byDay = new Map(week.days.map((d) => [d.key, []]));
    for (const item of filteredItems) {
      const key = getLocalDayKey(new Date(item.airingAt * 1000));
      const bucket = byDay.get(key);
      if (bucket) bucket.push(item);
    }

    if (!state.calendar.selectedDayKey || !byDay.has(state.calendar.selectedDayKey)) {
      const todayEntry = week.days.find((d) => d.isToday);
      state.calendar.selectedDayKey = todayEntry ? todayEntry.key : week.days[0].key;
    }

    const useSingleDayMode = state.calendar.layout === 'day' || window.innerWidth < 960;
    el.calendarGrid.classList.toggle('is-day-mode', useSingleDayMode);
    el.calDayTabs.classList.toggle('force-show', useSingleDayMode);

    el.calDayTabs.innerHTML = week.days
      .map((d) => {
        const count = byDay.get(d.key)?.length || 0;
        const active = d.key === state.calendar.selectedDayKey ? ' active' : '';
        const todayCls = d.isToday ? ' today' : '';
        return `
          <button type="button" role="tab" class="cal-day-tab${active}${todayCls}" data-cal-day="${d.key}" aria-selected="${d.key === state.calendar.selectedDayKey ? 'true' : 'false'}">
            <span class="cal-day-tab-wk">${escapeHtml(d.weekdayShort)}</span>
            <span class="cal-day-tab-dt">${escapeHtml(d.dateShort)}</span>
            <span class="cal-day-tab-cnt">${count}</span>
          </button>
        `;
      })
      .join('');

    const daysToRender = useSingleDayMode
      ? week.days.filter((d) => d.key === state.calendar.selectedDayKey)
      : week.days;
    syncCalendarToggleSectionsButton(daysToRender, byDay);

    requestAnimationFrame(() => {
      const activeTab = el.calDayTabs.querySelector('.cal-day-tab.active');
      if (activeTab && el.calDayTabs.scrollWidth > el.calDayTabs.clientWidth) {
        el.calDayTabs.scrollLeft = activeTab.offsetLeft - (el.calDayTabs.clientWidth - activeTab.offsetWidth) / 2;
      }
    });

    if (filteredItems.length === 0 && state.calendar.watchlistOnly) {
      el.calendarGrid.innerHTML = `<div class="empty-state">No scheduled or recent drops this week for your Watchlist.</div>`;
      return;
    }

    const perDayCap = useSingleDayMode ? 24 : 6;

    el.calendarGrid.innerHTML = daysToRender
      .map((d) => {
        const dayItems = byDay.get(d.key) || [];
        const isCollapsed = isCalendarSectionCollapsed(d.key, dayItems.length);
        const isListExpanded = Boolean(state.calendar.expandedLists[d.key]);
        const hasOverflow = !state.calendar.watchlistOnly && dayItems.length > perDayCap;
        const visibleItems = hasOverflow && !isListExpanded ? dayItems.slice(0, perDayCap) : dayItems;
        const remainingCount = dayItems.length - visibleItems.length;
        return `
          <section class="cal-day-col${d.isToday ? ' today' : ''}${isCollapsed ? ' collapsed' : ''}">
            <header class="cal-day-col-header">
              <button type="button" class="cal-day-toggle-btn" data-cal-section-toggle="${d.key}" data-cal-section-count="${dayItems.length}" aria-expanded="${isCollapsed ? 'false' : 'true'}" aria-label="${isCollapsed ? 'Show day section' : 'Hide day section'}" title="${isCollapsed ? 'Show section' : 'Hide section'}">
                <div class="cal-day-col-titles">
                  <span class="cal-day-col-wk">${escapeHtml(d.weekdayLong)}</span>
                  <span class="cal-day-col-dt">${escapeHtml(d.dateShort)}</span>
                </div>
                <div class="cal-day-col-meta">
                  ${d.isToday ? '<span class="cal-today-pill">Today</span>' : ''}
                  <span class="cal-count-pill">${dayItems.length}</span>
                  <svg class="cal-section-chevron" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
                </div>
              </button>
            </header>
            <div class="cal-day-list" ${isCollapsed ? 'hidden' : ''}>
              ${
                visibleItems.length > 0
                  ? visibleItems.map(renderCalendarCard).join('')
                  : '<div class="cal-day-empty">No scheduled drops</div>'
              }
              ${
                hasOverflow
                  ? `<button type="button" class="cal-show-more-btn" data-cal-expand-list="${d.key}">${
                      isListExpanded ? 'Show less' : `Show ${remainingCount} more`
                    }</button>`
                  : ''
              }
            </div>
          </section>
        `;
      })
      .join('');
  }

  function renderWatchlist() {
    const savedList = Object.values(state.saved);
    el.savedGrid.innerHTML =
      savedList.length > 0
        ? savedList.map((it) => renderSeriesCard(it)).join('')
        : `<div class="empty-state">No series in your Watchlist yet. Tap the bookmark icon on any show to save it here.</div>`;
  }

  function renderSongsChannelOptions() {
    if (!el.songsChannelSelect) return;
    const prev = state.songs.channelId || '';
    const opts = ['<option value="">All Channels</option>'];
    for (const c of state.channels) {
      opts.push(`<option value="${c.id}">${escapeHtml(c.name)}</option>`);
    }
    el.songsChannelSelect.innerHTML = opts.join('');
    el.songsChannelSelect.value = prev;
  }

  function formatSongTypeLabel(type) {
    if (type === 'op') return 'OP';
    if (type === 'ed') return 'ED';
    return 'OST';
  }

  function updateSongTypeChipCounts() {
    if (!el.songsTypeChips) return;
    const c = state.songs.counts || { all: 0, op: 0, ed: 0, ost: 0 };
    el.songsTypeChips.querySelectorAll('[data-count-for]').forEach((node) => {
      const key = node.dataset.countFor;
      node.textContent = String(c[key] || 0);
    });
    el.songsTypeChips.querySelectorAll('[data-song-type]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.songType === state.songs.type);
    });
  }

  async function loadSongs(append = false) {
    if (!el.songsGrid || state.songs.loading) return;
    state.songs.loading = true;
    if (!append) {
      state.songs.page = 1;
      el.songsGrid.innerHTML = `<div class="empty-state">Loading anime songs…</div>`;
    }
    try {
      const params = {
        type: state.songs.type,
        sort: state.songs.sort,
        page: String(state.songs.page),
        limit: String(getPageLimit()),
      };
      if (state.songs.group === 'anime') params.group = 'anime';
      if (state.songs.q) params.q = state.songs.q;
      if (state.songs.channelId) params.channel = state.songs.channelId;

      const data = await fetchJson(apiUrl('/api/songs', params));
      state.songs.loadedOnce = true;
      state.songs.total = data.total || 0;
      state.songs.counts = data.counts || { all: 0, op: 0, ed: 0, ost: 0 };
      if (state.songs.group === 'anime') {
        state.songs.groups = append ? [...state.songs.groups, ...(data.groups || [])] : data.groups || [];
      } else {
        state.songs.items = append ? [...state.songs.items, ...(data.items || [])] : data.items || [];
      }
      updateSongTypeChipCounts();
      renderSongsGrid();
    } catch (err) {
      el.songsGrid.innerHTML = `<div class="empty-state">Failed to load songs.</div>`;
    } finally {
      state.songs.loading = false;
    }
  }

  function renderSongsGrid() {
    if (!el.songsGrid) return;
    if (state.songs.group === 'anime') {
      const groups = state.songs.groups;
      if (el.songsCountLine) {
        el.songsCountLine.textContent =
          state.songs.total > 0
            ? `${state.songs.total.toLocaleString()} anime collection${state.songs.total === 1 ? '' : 's'}`
            : '0 collections';
      }
      if (el.songsPagination) {
        el.songsPagination.hidden = groups.length >= state.songs.total;
      }
      if (groups.length === 0) {
        el.songsGrid.innerHTML = `<div class="empty-state">No anime song collections found yet. Run "Sync Songs" in the admin portal to index official OP, ED, and OST playlists.</div>`;
        if (state.songs.q) {
          maybeMountAdminYtSearch(el.songsGrid, 'songs', state.songs.q, false);
        }
        return;
      }
      el.songsGrid.innerHTML = groups
        .map((grp, idx) => {
          const firstVid = grp.tracks[0]?.youtubeVideoId || '';
          const thumb =
            safeUrl(optimizeThumbUrl(grp.thumbnailUrl)) ||
            (firstVid ? `https://i.ytimg.com/vi/${encodeURIComponent(firstVid)}/mqdefault.jpg` : '');
          const avatar = safeUrl(grp.channelAvatar);
          const pills = [
            grp.opCount > 0 ? `<span class="song-group-pill op">${grp.opCount} OP</span>` : '',
            grp.edCount > 0 ? `<span class="song-group-pill ed">${grp.edCount} ED</span>` : '',
            grp.ostCount > 0 ? `<span class="song-group-pill ost">${grp.ostCount} OST</span>` : '',
          ]
            .filter(Boolean)
            .join('');
          const stats = [formatViews(grp.totalViews), formatRelativeDate(grp.latestPublishedAt)].filter(Boolean).join(' · ');
          return `
            <article class="song-card" data-song-group-index="${idx}" tabindex="0" role="button">
              <div class="song-thumb-wrap">
                ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />` : ''}
                <span class="song-dur">${grp.trackCount} track${grp.trackCount === 1 ? '' : 's'}</span>
                ${PLAY_OVERLAY}
              </div>
              <div class="song-body">
                ${avatar ? `<img class="song-ch-avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" />` : ''}
                <div class="song-info">
                  <div class="song-title">${escapeHtml(grp.title)}</div>
                  <div class="song-channel">${escapeHtml(grp.channelName)}</div>
                  ${stats ? `<div class="song-stats">${escapeHtml(stats)}</div>` : ''}
                  ${pills ? `<div class="song-group-pills">${pills}</div>` : ''}
                </div>
              </div>
            </article>
          `;
        })
        .join('');
      if (state.songs.q) {
        maybeMountAdminYtSearch(el.songsGrid, 'songs', state.songs.q, true);
      }
      return;
    }

    const items = state.songs.items;
    if (el.songsCountLine) {
      el.songsCountLine.textContent =
        state.songs.total > 0
          ? `${state.songs.total.toLocaleString()} song${state.songs.total === 1 ? '' : 's'}`
          : '0 songs';
    }
    if (el.songsPagination) {
      el.songsPagination.hidden = items.length >= state.songs.total;
    }
    if (items.length === 0) {
      el.songsGrid.innerHTML = `<div class="empty-state">No anime songs (OP, ED, OST) found yet. Run a channel sync to index official music playlists &amp; theme songs.</div>`;
      if (state.songs.q) {
        maybeMountAdminYtSearch(el.songsGrid, 'songs', state.songs.q, false);
      }
      return;
    }

    el.songsGrid.innerHTML = items
      .map((song, idx) => {
        const thumb = safeUrl(optimizeThumbUrl(song.thumbnailUrl)) || `https://i.ytimg.com/vi/${encodeURIComponent(song.youtubeVideoId)}/mqdefault.jpg`;
        const avatar = safeUrl(song.channelAvatar);
        const dur = formatDuration(song.durationIso);
        const typeLbl = formatSongTypeLabel(song.songType);
        const stats = [formatViews(song.viewCount), formatRelativeDate(song.publishedAt)].filter(Boolean).join(' · ');
        return `
          <article class="song-card" data-song-index="${idx}" tabindex="0" role="button">
            <div class="song-thumb-wrap">
              <img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />
              <span class="song-type-badge ${escapeHtml(song.songType)}">${typeLbl}</span>
              ${dur ? `<span class="song-dur">${escapeHtml(dur)}</span>` : ''}
              ${PLAY_OVERLAY}
            </div>
            <div class="song-body">
              ${avatar ? `<img class="song-ch-avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" />` : ''}
              <div class="song-info">
                <div class="song-title">${escapeHtml(song.title)}</div>
                <div class="song-channel">${escapeHtml(song.channelName)}</div>
                ${stats ? `<div class="song-stats">${escapeHtml(stats)}</div>` : ''}
              </div>
            </div>
          </article>
        `;
      })
      .join('');
    if (state.songs.q) {
      maybeMountAdminYtSearch(el.songsGrid, 'songs', state.songs.q, true);
    }
  }

  function openSongGroupWatch(groupIndex) {
    const grp = state.songs.groups[groupIndex];
    if (!grp || !grp.tracks || grp.tracks.length === 0) return;
    state.watchReturnView = 'songs';
    state.watch = { songList: grp.tracks, activeSongIndex: 0 };
    el.episodeQueuePanel.hidden = false;
    el.saveSeriesBtn.hidden = true;
    switchView('watch');
    playActiveSong();
  }

  function openSongWatch(songIndex) {
    const items = state.songs.items;
    if (!items || !items[songIndex]) return;
    state.watchReturnView = 'songs';
    state.watch = { songList: items, activeSongIndex: songIndex };
    el.episodeQueuePanel.hidden = false;
    el.saveSeriesBtn.hidden = true;
    switchView('watch');
    playActiveSong();
  }

  function playActiveSong() {
    const w = state.watch;
    if (!w || !w.songList) return;
    const song = w.songList[w.activeSongIndex];
    if (!song) return;

    const typeLbl = formatSongTypeLabel(song.songType);
    setDocumentTitle(`${song.title} (${typeLbl}) — ${song.channelName} | AnimaxTube`);
    el.watchSeriesTitle.textContent = song.animeTitle || `${typeLbl} · Anime Music`;
    el.watchEpisodeTitle.textContent = song.title;

    const avatar = safeUrl(song.channelAvatar);
    const chUrl = safeUrl(song.channelUrl);
    el.watchChannelMeta.innerHTML = `
      ${avatar ? `<img src="${escapeHtml(avatar)}" alt="" />` : ''}
      <div>
        <div style="font-weight:700;font-size:0.96rem">${escapeHtml(song.channelName)} <span class="verified-icon">✓</span></div>
        ${chUrl ? `<div style="font-size:0.78rem;color:var(--text-muted)"><a href="${escapeHtml(chUrl)}" target="_blank" rel="noopener noreferrer">Open channel on YouTube ↗</a></div>` : ''}
      </div>
    `;
    el.watchLikePill.textContent = song.likeCount ? `${formatCompact(song.likeCount)} likes` : typeLbl;
    el.watchViewPill.textContent = song.viewCount ? `${formatCompact(song.viewCount)} views` : 'Official Music';
    el.sourceSwitcher.innerHTML = `<span class="ch-pill">${typeLbl}</span>`;

    const descStats = [
      song.viewCount ? `${song.viewCount.toLocaleString()} views` : null,
      song.publishedAt ? `Uploaded ${formatFullDate(song.publishedAt)}` : null,
    ].filter(Boolean);
    el.watchDescStats.textContent = descStats.join(' · ') || 'Official Anime Music';
    el.watchDescTags.innerHTML = '';
    el.watchSynopsis.textContent = song.playlistTitle
      ? `From official playlist: ${song.playlistTitle}`
      : `Official anime ${typeLbl} published by ${song.channelName}.`;
    el.watchEpDescription.hidden = true;
    el.watchBuzzQuote.hidden = true;

    const queueTitle = el.episodeQueuePanel?.querySelector('.queue-title');
    if (queueTitle) queueTitle.textContent = 'Songs Queue';
    el.queueSubInfo.textContent = `${w.activeSongIndex + 1} / ${w.songList.length} · ${typeLbl}`;

    el.episodeList.innerHTML = w.songList
      .map((item, idx) => {
        const active = idx === w.activeSongIndex ? ' active' : '';
        const dur = formatDuration(item.durationIso);
        const thumb = safeUrl(optimizeThumbUrl(item.thumbnailUrl)) || `https://i.ytimg.com/vi/${encodeURIComponent(item.youtubeVideoId)}/mqdefault.jpg`;
        const subStats = [item.channelName, formatViews(item.viewCount)].filter(Boolean).join(' · ');
        return `
          <button class="ep-item${active}" data-song-queue-index="${idx}">
            <div class="ep-thumb-wrap">
              <img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" />
              ${dur ? `<span class="ep-dur">${escapeHtml(dur)}</span>` : ''}
            </div>
            <div class="ep-meta">
              <div class="ep-num">${formatSongTypeLabel(item.songType)}</div>
              <div class="ep-title">${escapeHtml(item.title)}</div>
              ${subStats ? `<div class="ep-substats">${escapeHtml(subStats)}</div>` : ''}
            </div>
          </button>
        `;
      })
      .join('');

    const playlistUrl = song.playlistId ? `https://www.youtube.com/playlist?list=${encodeURIComponent(song.playlistId)}` : '';
    const geo = { regionAllowed: song.regionAllowed, regionBlocked: song.regionBlocked, regionFocus: song.regionFocus };
    const locked = getGeoLock(geo);
    renderLicensorBanner({
      channelName: song.channelName,
      channelUrl: song.channelUrl,
      playlistUrl,
      videoId: song.youtubeVideoId,
      locked,
      geo,
    });
    if (locked) {
      showGeoLockCard({
        title: song.title,
        channelName: song.channelName,
        officialUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(song.youtubeVideoId)}`,
        geo,
      });
      return;
    }
    showPlayerFrame();
    window.AnimaxPlayer.playVideo('ytPlayerMount', song.youtubeVideoId, () => {
      if (el.autoNextCheckbox.checked && w.activeSongIndex < w.songList.length - 1) {
        w.activeSongIndex += 1;
        playActiveSong();
      }
    });
  }

  function renderHistory() {
    const historyList = getHistoryList();
    if (el.clearHistoryBtn) {
      el.clearHistoryBtn.hidden = historyList.length === 0;
    }
    el.historyGrid.innerHTML =
      historyList.length > 0
        ? historyList.map((h) => renderSeriesCard(h.series, { removable: true })).join('')
        : `<div class="empty-state">Your watch history is empty.</div>`;
  }

  function syncWatchlistButtonsForSlug(slug) {
    const isSaved = Boolean(state.saved[slug]);
    document.querySelectorAll('.card-watchlist-btn').forEach((btn) => {
      if (btn.dataset.watchlistToggle !== slug) return;
      btn.classList.toggle('saved', isSaved);
      btn.setAttribute('aria-pressed', isSaved ? 'true' : 'false');
      btn.setAttribute('aria-label', isSaved ? 'Remove from Watchlist' : 'Add to Watchlist');
      btn.title = isSaved ? 'In Watchlist' : 'Add to Watchlist';
      btn.innerHTML = isSaved ? BOOKMARK_FILLED_ICON : BOOKMARK_OUTLINE_ICON;
    });
    if (state.watch?.detail?.series?.slug === slug && el.saveSeriesBtn) {
      el.saveSeriesBtn.textContent = isSaved ? '✓ In Watchlist' : '+ Watchlist';
    }
    document.querySelectorAll('.cal-watchlist-btn').forEach((btn) => {
      if (btn.dataset.watchlistToggle !== slug) return;
      btn.classList.toggle('saved', isSaved);
      btn.setAttribute('aria-pressed', isSaved ? 'true' : 'false');
      btn.setAttribute('aria-label', isSaved ? 'Remove from Watchlist' : 'Add to Watchlist');
      btn.title = isSaved ? 'In Watchlist' : 'Add to Watchlist';
      btn.innerHTML = isSaved ? BOOKMARK_FILLED_ICON : BOOKMARK_OUTLINE_ICON;
    });
  }

  function toggleWatchlistBySlug(slug) {
    if (!slug) return;
    if (state.saved[slug]) {
      delete state.saved[slug];
    } else {
      const item = seriesCatalog.get(slug) || state.history[slug]?.series;
      if (!item) return;
      state.saved[slug] = toSavedEntry(item, item.channels || []);
    }
    saveJson(STORAGE_SAVED, state.saved);
    syncWatchlistButtonsForSlug(slug);
    if (state.view === 'watchlist') {
      renderWatchlist();
    }
  }

  function removeHistoryBySlug(slug) {
    if (!slug || !state.history[slug]) return;
    delete state.history[slug];
    saveJson(STORAGE_HISTORY, state.history);
    if (state.view === 'history') renderHistory();
    renderHomeShelves();
    loadForYou().then(renderHomeShelves);
  }

  function clearAllHistory() {
    if (Object.keys(state.history).length === 0) return;
    state.history = {};
    saveJson(STORAGE_HISTORY, state.history);
    state.forYouRows = [];
    if (state.view === 'history') renderHistory();
    renderHomeShelves();
  }

  function parseRegionCodes(value) {
    let list = value;
    if (typeof value === 'string') {
      try {
        list = JSON.parse(value);
      } catch {
        list = [];
      }
    }
    return Array.isArray(list) ? list.map((c) => String(c).toUpperCase()) : [];
  }

  function visitorCountry() {
    return state.region && state.region !== 'ALL' ? state.region : null;
  }

  function isAsiaOnlyFocus(focus) {
    if (!focus) return false;
    return !/global|world|international|north america|europe|latin/i.test(focus);
  }

  /**
   * Mirrors YouTube's own territorial restriction so the iframe is never created for
   * visitors outside the licensee's region. Unknown visitors are treated as out-of-region
   * for Asia-only licensees.
   */
  function getGeoLock({ regionAllowed, regionBlocked, regionFocus }) {
    const country = visitorCountry();
    const allowed = parseRegionCodes(regionAllowed);
    const blocked = parseRegionCodes(regionBlocked);
    if (country) {
      if (blocked.includes(country)) return true;
      if (allowed.length > 0) return !allowed.includes(country);
      if (!isAsiaOnlyFocus(regionFocus)) return false;
      if (ASIA_REGION_CODES.has(country)) return false;
      return !(OCEANIA_REGION_CODES.has(country) && /pacific|oceania|australia/i.test(regionFocus));
    }
    return allowed.length > 0 || isAsiaOnlyFocus(regionFocus);
  }

  function describeTerritory({ regionAllowed, regionBlocked, regionFocus }) {
    const allowed = parseRegionCodes(regionAllowed);
    const blocked = parseRegionCodes(regionBlocked);
    if (allowed.length > 0) {
      const shown = allowed.slice(0, 12).join(', ');
      const more = allowed.length > 12 ? ` +${allowed.length - 12} more` : '';
      return `Licensed for playback in ${allowed.length} ${allowed.length === 1 ? 'country' : 'countries'} per YouTube (${shown}${more})${regionFocus ? ` · channel focus: ${regionFocus}` : ''}.`;
    }
    if (blocked.length > 0) {
      return `Available on YouTube everywhere except ${blocked.slice(0, 12).join(', ')}${blocked.length > 12 ? '…' : ''}.`;
    }
    if (regionFocus) {
      return `Channel licensed for ${regionFocus}. Territorial restrictions are enforced natively by YouTube.`;
    }
    return 'Availability is set by the rights holder and enforced natively by YouTube.';
  }

  function renderLicensorBanner({ channelName, channelUrl, playlistUrl, videoId, locked, geo }) {
    if (!el.licensorBanner) return;
    const safePlaylist = safeUrl(playlistUrl);
    const safeChannel = safeUrl(channelUrl);
    const links = [
      videoId
        ? `<a class="licensor-link primary" href="https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}" target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a>`
        : '',
      safePlaylist
        ? `<a class="licensor-link" href="${escapeHtml(safePlaylist)}" target="_blank" rel="noopener noreferrer">Official playlist ↗</a>`
        : '',
      safeChannel
        ? `<a class="licensor-link" href="${escapeHtml(safeChannel)}" target="_blank" rel="noopener noreferrer">${escapeHtml(channelName)} on YouTube ↗</a>`
        : '',
    ].join('');
    const body = locked
      ? `Officially published on YouTube by <strong>${escapeHtml(channelName)}</strong> (Official Regional Licensee). The player is not loaded outside the licensed territory; nothing is re-hosted or proxied by AnimaxTube.`
      : `Streamed directly via the official YouTube IFrame API from <strong>${escapeHtml(channelName)}</strong> (Official Regional Licensee). All views, ad impressions, and watch-time telemetry go directly to the official rights holder.`;
    el.licensorBanner.innerHTML = `
      <div class="licensor-head">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
        <span>Verified Official Stream</span>
      </div>
      <p class="licensor-text">${body}</p>
      <div class="licensor-links">${links}</div>
      <p class="licensor-territory"><strong>Territorial availability:</strong> ${escapeHtml(describeTerritory(geo))}</p>
    `;
    el.licensorBanner.hidden = false;
  }

  function showPlayerFrame() {
    el.playerFrame?.classList.remove('locked');
    if (el.geoLockCard) {
      el.geoLockCard.hidden = true;
      el.geoLockCard.innerHTML = '';
    }
  }

  function showGeoLockCard({ title, channelName, officialUrl, geo }) {
    window.AnimaxPlayer.destroy('ytPlayerMount', el.playerFrame);
    if (!el.geoLockCard) return;
    const country = visitorCountry() || 'Unknown';
    const q = encodeURIComponent(title);
    const focus = geo.regionFocus || 'Southeast Asia / South Asia';
    const safeOfficial = safeUrl(officialUrl);
    el.playerFrame?.classList.add('locked');
    el.geoLockCard.innerHTML = `
      <div class="geo-lock-inner">
        <div class="geo-lock-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        </div>
        <h2 class="geo-lock-title">Unavailable on YouTube in Your Region (${escapeHtml(country)})</h2>
        <p class="geo-lock-text">
          <strong>${escapeHtml(title)}</strong> is licensed to <strong>${escapeHtml(channelName)}</strong> for ${escapeHtml(focus)},
          so AnimaxTube does not load the player in your region. Outside that territory, it may be licensed to other services such as Crunchyroll, Netflix, or HIDIVE.
        </p>
        <div class="geo-lock-actions">
          <a class="btn-primary" href="https://www.crunchyroll.com/search?q=${q}" target="_blank" rel="noopener noreferrer">Search on Crunchyroll ↗</a>
          <a class="btn-outline" href="https://www.netflix.com/search?q=${q}" target="_blank" rel="noopener noreferrer">Search on Netflix ↗</a>
          <a class="btn-outline" href="https://www.hidive.com/search?q=${q}" target="_blank" rel="noopener noreferrer">Search on HIDIVE ↗</a>
        </div>
        ${
          safeOfficial
            ? `<a class="geo-lock-official" href="${escapeHtml(safeOfficial)}" target="_blank" rel="noopener noreferrer">View Official ${escapeHtml(channelName)} YouTube Link (Geo-Restricted) ↗</a>`
            : ''
        }
      </div>
    `;
    el.geoLockCard.hidden = false;
  }

  function setDocumentTitle(title) {
    document.title = title || SITE_TITLE;
  }

  function setWatchDocumentTitle(seriesTitle, channelName) {
    setDocumentTitle(`${seriesTitle} — Official YouTube Stream Directory (${channelName}) | AnimaxTube`);
  }

  function pushPath(path, stateObj = {}) {
    if (window.location.pathname !== path) history.pushState(stateObj, '', path);
  }

  function openLockedSeriesWatch(detail, slug) {
    const series = detail.series;
    const sources = detail.lockedSources || [];
    const primary = sources[0] || { channelName: 'the official licensee' };
    state.watch = { lockedDetail: detail };
    switchView('watch');
    pushPath(`/watch/${encodeURIComponent(slug)}`, { slug });
    el.episodeQueuePanel.hidden = true;
    el.saveSeriesBtn.hidden = true;

    el.watchSeriesTitle.textContent = series.canonicalTitle;
    el.watchEpisodeTitle.textContent = `Region locked in ${visitorCountry() || 'your region'}`;
    const primaryAvatar = safeUrl(primary.channelAvatar);
    el.watchChannelMeta.innerHTML = `
      ${primaryAvatar ? `<img src="${escapeHtml(primaryAvatar)}" alt="" />` : ''}
      <div>
        <div style="font-weight:700;font-size:0.96rem">${escapeHtml(primary.channelName)} <span class="verified-icon">✓</span></div>
        <div style="font-size:0.78rem;color:var(--text-muted)">Official regional licensee</div>
      </div>
    `;
    el.watchLikePill.textContent = series.totalLikes ? `${formatCompact(series.totalLikes)} likes` : 'Official';
    el.watchViewPill.textContent = series.totalViews ? `${formatCompact(series.totalViews)} views` : 'Geo-restricted';
    el.sourceSwitcher.innerHTML = sources
      .slice(1)
      .map((s) => {
        const sUrl = safeUrl(s.playlistUrl || s.channelUrl);
        return sUrl
          ? `<a class="source-btn" href="${escapeHtml(sUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.channelName)} (${formatLangBadge(s.subLanguage).label}) ↗</a>`
          : '';
      })
      .join('');
    el.watchDescStats.textContent = series.totalViews ? `${series.totalViews.toLocaleString()} series views` : 'Official Stream';
    el.watchDescTags.innerHTML = '';
    el.watchSynopsis.textContent = series.synopsis || `Official playlist from ${primary.channelName}.`;
    el.watchEpDescription.hidden = true;
    el.watchBuzzQuote.hidden = true;

    const geo = { regionFocus: primary.regionFocus };
    showGeoLockCard({
      title: series.canonicalTitle,
      channelName: primary.channelName,
      officialUrl: primary.playlistUrl || primary.channelUrl,
      geo,
    });
    renderLicensorBanner({
      channelName: primary.channelName,
      channelUrl: primary.channelUrl,
      playlistUrl: primary.playlistUrl,
      locked: true,
      geo,
    });
    setWatchDocumentTitle(series.canonicalTitle, primary.channelName);
  }

  function renderLegalChannels() {
    if (!el.legalChannelList) return;
    const channels = [...state.channels].sort((a, b) => (b.seriesCount || 0) - (a.seriesCount || 0));
    el.legalChannelList.innerHTML = channels.length
      ? channels
          .map((c) => {
            const cUrl = safeUrl(c.url);
            if (!cUrl) return '';
            return `
          <a class="legal-channel" href="${escapeHtml(cUrl)}" target="_blank" rel="noopener noreferrer">
            <span class="legal-channel-name">${escapeHtml(c.name)}</span>
            <span class="legal-channel-region">${escapeHtml(c.regionFocus || 'Global')}</span>
          </a>`;
          })
          .join('')
      : '<p class="legal-muted">Channel list unavailable.</p>';
  }

  function openLiveStreamWatch(videoId) {
    const ls = state.liveStreams.find((s) => s.youtube_video_id === videoId);
    if (!ls) return;
    state.watch = { liveStream: ls };
    switchView('watch');
    el.episodeQueuePanel.hidden = true;
    el.saveSeriesBtn.hidden = true;
    setDocumentTitle(`${ls.title} — Official YouTube Live Stream (${ls.channel_name}) | AnimaxTube`);

    el.watchSeriesTitle.textContent = ls.title;
    el.watchEpisodeTitle.textContent =
      ls.status === 'live'
        ? `● LIVE NOW · ${formatCompact(ls.concurrentViewers)} watching`
        : 'Upcoming Premiere / Marathon';
    const lsAvatar = safeUrl(ls.channel_avatar);
    const lsChannelUrl = safeUrl(ls.channel_url);
    el.watchChannelMeta.innerHTML = `
      ${lsAvatar ? `<img src="${escapeHtml(lsAvatar)}" alt="" />` : ''}
      <div>
        <div style="font-weight:700">${escapeHtml(ls.channel_name)} <span class="verified-icon">✓</span></div>
        ${lsChannelUrl ? `<div style="font-size:0.78rem;color:var(--text-muted)"><a href="${escapeHtml(lsChannelUrl)}" target="_blank" rel="noopener noreferrer">Open channel on YouTube ↗</a></div>` : ''}
      </div>
    `;
    el.watchLikePill.textContent = '● Live Stream';
    el.watchViewPill.textContent = ls.concurrentViewers > 0 ? `${formatCompact(ls.concurrentViewers)} watching` : 'Live';
    el.sourceSwitcher.innerHTML = '';
    el.watchDescStats.textContent = ls.started_at ? `Started ${formatRelativeDate(ls.started_at)}` : 'Live Broadcast';
    el.watchDescTags.innerHTML = '';
    el.watchSynopsis.textContent = 'Official live anime marathon or premiere broadcast.';
    el.watchEpDescription.hidden = true;
    el.watchBuzzQuote.hidden = true;

    const geo = { regionAllowed: ls.region_allowed, regionBlocked: ls.region_blocked, regionFocus: ls.region_focus };
    const locked = getGeoLock(geo);
    renderLicensorBanner({
      channelName: ls.channel_name,
      channelUrl: ls.channel_url,
      videoId: ls.youtube_video_id,
      locked,
      geo,
    });
    if (locked) {
      showGeoLockCard({
        title: ls.title,
        channelName: ls.channel_name,
        officialUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(ls.youtube_video_id)}`,
        geo,
      });
      return;
    }
    showPlayerFrame();
    window.AnimaxPlayer.playVideo('ytPlayerMount', ls.youtube_video_id);
  }

  async function openSeriesWatch(slug, preferredVideoId) {
    const detail = await fetchJson(apiUrl(`/api/series/${encodeURIComponent(slug)}`));
    const sources = detail.sources || [];
    const episodes = detail.episodes || [];
    if (sources.length === 0 || episodes.length === 0) {
      if (detail.regionBlocked && detail.series) {
        openLockedSeriesWatch(detail, slug);
      }
      return;
    }

    const historyEntry = state.history[slug];
    let activeSourceId = sources[0].id;
    let targetVideoId = preferredVideoId || historyEntry?.videoId || null;

    if (targetVideoId) {
      const matched = episodes.find((e) => e.youtubeVideoId === targetVideoId);
      if (matched) activeSourceId = matched.channelSeriesId;
    }

    const sourceEpisodes = episodes.filter((e) => e.channelSeriesId === activeSourceId);
    let activeIndex = targetVideoId
      ? sourceEpisodes.findIndex((e) => e.youtubeVideoId === targetVideoId)
      : 0;
    if (activeIndex < 0) activeIndex = 0;

    state.watchReturnView = 'series';
    state.watch = { detail, activeSourceId, activeEpisodeIndex: activeIndex };
    const queueTitle = el.episodeQueuePanel?.querySelector('.queue-title');
    if (queueTitle) queueTitle.textContent = 'Episodes';
    el.episodeQueuePanel.hidden = false;
    el.saveSeriesBtn.hidden = false;

    switchView('watch');
    pushPath(`/watch/${encodeURIComponent(slug)}`, { slug });
    renderWatchView();
    playActiveEpisode();
  }

  function getActiveSourceEpisodes() {
    if (!state.watch || !state.watch.detail) return [];
    return state.watch.detail.episodes.filter((e) => e.channelSeriesId === state.watch.activeSourceId);
  }

  function renderWatchView() {
    const w = state.watch;
    if (!w || !w.detail) return;
    const { series, sources } = w.detail;
    const source = sources.find((s) => s.id === w.activeSourceId) || sources[0];
    const eps = getActiveSourceEpisodes();
    const ep = eps[w.activeEpisodeIndex];

    el.watchSeriesTitle.textContent = series.canonicalTitle;
    el.watchEpisodeTitle.textContent = ep ? ep.title : '';
    setWatchDocumentTitle(series.canonicalTitle, source.channelName);
    const isSaved = Boolean(state.saved[series.slug]);
    el.saveSeriesBtn.textContent = isSaved ? '✓ In Watchlist' : '+ Watchlist';

    const srcAvatar = safeUrl(source.channelAvatar);
    const srcPlaylistUrl = safeUrl(source.playlistUrl);
    el.watchChannelMeta.innerHTML = `
      ${srcAvatar ? `<img src="${escapeHtml(srcAvatar)}" alt="" />` : ''}
      <div>
        <div style="font-weight:700;font-size:0.96rem">${escapeHtml(source.channelName)} <span class="verified-icon">✓</span></div>
        ${srcPlaylistUrl ? `<div style="font-size:0.78rem;color:var(--text-muted)">
          <a href="${escapeHtml(srcPlaylistUrl)}" target="_blank" rel="noopener noreferrer">Open YouTube Playlist ↗</a>
        </div>` : ''}
      </div>
    `;

    const epViews = ep?.viewCount ?? series.totalViews;
    const epLikes = ep?.likeCount ?? series.totalLikes;
    el.watchLikePill.textContent = epLikes ? `${formatCompact(epLikes)} likes` : 'Official';
    el.watchViewPill.textContent = epViews ? `${formatCompact(epViews)} views` : `${eps.length} episodes`;

    el.sourceSwitcher.innerHTML =
      sources.length > 1
        ? sources
            .map((s) => {
              const b = formatLangBadge(s.subLanguage);
              const active = s.id === source.id ? ' active' : '';
              return `<button class="source-btn${active}" data-source-id="${s.id}">${escapeHtml(s.channelName)} (${b.label})</button>`;
            })
            .join('')
        : `<span class="ch-pill">${escapeHtml(formatLangBadge(source.subLanguage).label)}</span>`;

    // YouTube Description box (Views · Upload Date · Tags · Description)
    const uploadStr = ep?.publishedAt ? formatFullDate(ep.publishedAt) : formatFullDate(series.latestUploadedAt);
    const descStatsParts = [];
    if (ep?.viewCount) descStatsParts.push(`${ep.viewCount.toLocaleString()} views`);
    else if (series.totalViews) descStatsParts.push(`${series.totalViews.toLocaleString()} series views`);
    if (uploadStr) descStatsParts.push(`Uploaded ${uploadStr}`);
    el.watchDescStats.textContent = descStatsParts.join(' · ') || 'Official Stream';

    const mergedTags = [...new Set([...(ep?.tags || []), ...(series.tags || [])])].slice(0, 8);
    el.watchDescTags.innerHTML = mergedTags
      .map((t) => `<button type="button" class="tag-chip" data-tag-click="${escapeHtml(t)}">#${escapeHtml(t)}</button>`)
      .join('');

    el.watchSynopsis.textContent = series.synopsis || `Official playlist from ${source.channelName}.`;
    if (ep?.description) {
      el.watchEpDescription.hidden = false;
      el.watchEpDescription.textContent = ep.description;
    } else {
      el.watchEpDescription.hidden = true;
    }

    if (series.topCommentQuote) {
      el.watchBuzzQuote.hidden = false;
      el.watchBuzzQuote.textContent = `"${series.topCommentQuote}" — ${series.topCommentAuthor || 'Viewer'}, on Episode 1`;
    } else {
      el.watchBuzzQuote.hidden = true;
    }

    el.queueSubInfo.textContent = `${w.activeEpisodeIndex + 1} / ${eps.length} · ${source.channelName}`;
    const watchedSet = new Set(state.history[series.slug]?.watchedVideoIds || []);

    el.episodeList.innerHTML = eps
      .map((item, idx) => {
        const active = idx === w.activeEpisodeIndex ? ' active' : '';
        const dur = formatDuration(item.durationIso);
        const epLabel = item.episodeNumber !== null ? `Episode ${item.episodeNumber}` : `#${idx + 1}`;
        const watched = watchedSet.has(item.youtubeVideoId) ? `<span class="ep-watched">✓ Watched</span>` : '';
        const epSubStats = [formatViews(item.viewCount), formatRelativeDate(item.publishedAt)].filter(Boolean).join(' · ');
        const epThumb = safeUrl(optimizeThumbUrl(item.thumbnailUrl));
        return `
          <button class="ep-item${active}" data-ep-index="${idx}">
              <div class="ep-thumb-wrap">
                ${epThumb ? `<img src="${escapeHtml(epThumb)}" alt="" loading="lazy" decoding="async" />` : ''}
                ${dur ? `<span class="ep-dur">${dur}</span>` : ''}
              </div>
            <div class="ep-meta">
              <div class="ep-num">${epLabel}${watched}</div>
              <div class="ep-title">${escapeHtml(item.title)}</div>
              ${epSubStats ? `<div class="ep-substats">${escapeHtml(epSubStats)}</div>` : ''}
            </div>
          </button>
        `;
      })
      .join('');

  }

  function playActiveEpisode() {
    const w = state.watch;
    if (!w || !w.detail) return;
    const eps = getActiveSourceEpisodes();
    const ep = eps[w.activeEpisodeIndex];
    if (!ep) return;

    const { series } = w.detail;
    const existing = state.history[series.slug] || { watchedVideoIds: [] };
    const watchedSet = new Set(existing.watchedVideoIds || []);
    watchedSet.add(ep.youtubeVideoId);
    state.history[series.slug] = {
      series: toSavedEntry(
        series,
        w.detail.sources.map((s) => ({ channelName: s.channelName, channelAvatar: s.channelAvatar }))
      ),
      videoId: ep.youtubeVideoId,
      watchedVideoIds: [...watchedSet],
      watchedAt: Date.now(),
    };
    saveJson(STORAGE_HISTORY, state.history);
    renderWatchView();

    const source = w.detail.sources.find((s) => s.id === w.activeSourceId) || w.detail.sources[0];
    const geo = { regionAllowed: ep.regionAllowed, regionBlocked: ep.regionBlocked, regionFocus: source.regionFocus };
    const locked = getGeoLock(geo);
    renderLicensorBanner({
      channelName: source.channelName,
      channelUrl: source.channelUrl,
      playlistUrl: source.playlistUrl,
      videoId: ep.youtubeVideoId,
      locked,
      geo,
    });
    if (locked) {
      showGeoLockCard({
        title: series.canonicalTitle,
        channelName: source.channelName,
        officialUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(ep.youtubeVideoId)}`,
        geo,
      });
      return;
    }
    showPlayerFrame();

    window.AnimaxPlayer.playVideo('ytPlayerMount', ep.youtubeVideoId, () => {
      if (el.autoNextCheckbox.checked && w.activeEpisodeIndex < eps.length - 1) {
        w.activeEpisodeIndex += 1;
        playActiveEpisode();
      }
    });
  }

  function syncTopChipsActive() {
    if (!el.topChipBar) return;
    el.topChipBar.querySelectorAll('.chip[data-tag=""]').forEach((c) => {
      const isLangActive = !state.tag && c.dataset.lang === state.lang;
      c.classList.toggle('active', isLangActive);
    });
  }

  function updateChipScrollButtons() {
    if (!el.topChipBar || !el.chipPrevBtn || !el.chipNextBtn) return;
    const { scrollLeft, clientWidth, scrollWidth } = el.topChipBar;
    el.chipPrevBtn.hidden = scrollLeft <= 6;
    el.chipNextBtn.hidden = scrollLeft + clientWidth >= scrollWidth - 6;
  }

  function syncFilterBadge() {
    const activeLabels = [];
    if (state.channelId) activeLabels.push(`Channel: ${state.channelName}`);
    if (state.tag) activeLabels.push(`#${state.tag}`);
    el.activeFilterBadge.hidden = activeLabels.length === 0;
    el.activeFilterLabel.textContent = activeLabels.join(' · ');
  }

  function applyTagFilter(tag) {
    state.tag = state.tag === tag ? '' : tag;
    switchView('series');
    renderDynamicTags();
    syncTopChipsActive();
    syncFilterBadge();
    renderHomeShelves();
    if (window.scrollY > 140) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    loadSeries(false);
  }

  function setupInfiniteScroll() {
    if (!('IntersectionObserver' in window) || !el.loadMoreSentinel) return;
    loadMoreObserver = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          state.view === 'series' &&
          !state.isLoadingSeries &&
          state.seriesItems.length < state.total
        ) {
          state.page += 1;
          loadSeries(true);
        }
      },
      { rootMargin: '400px 0px' }
    );
    loadMoreObserver.observe(el.loadMoreSentinel);
  }

  function applyRouteFromUrl(pathname) {
    if (pathname.startsWith('/watch/')) {
      const preferredVideoId = new URLSearchParams(window.location.search).get('v') || undefined;
      openSeriesWatch(decodeURIComponent(pathname.slice('/watch/'.length)), preferredVideoId);
    } else if (pathname === '/calendar') {
      switchView('calendar');
    } else if (pathname === '/songs') {
      switchView('songs');
    } else if (pathname === '/channels') {
      switchView('channels');
    } else if (pathname === '/watchlist') {
      switchView('watchlist');
    } else if (pathname === '/history') {
      switchView('history');
    } else if (pathname === '/about' || pathname === '/legal' || pathname === '/dmca') {
      switchView('about');
      if (pathname !== '/about') {
        document.getElementById(pathname === '/dmca' ? 'legal-dmca' : 'legal-hosting')?.scrollIntoView();
      }
    } else {
      switchView('series');
    }
  }

  function bindEvents() {
    document.addEventListener(
      'error',
      (e) => {
        const img = e.target;
        if (img && img.tagName === 'IMG' && img.dataset.fallbackSrc) {
          const fb = img.dataset.fallbackSrc;
          delete img.dataset.fallbackSrc;
          img.src = fb;
        }
      },
      true
    );

    el.menuToggleBtn.addEventListener('click', () => {
      if (isOverlaySidebarViewport()) {
        setSidebarOpen(el.sidebar.classList.contains('collapsed'));
      } else {
        setSidebarOpen(el.sidebar.classList.contains('mini'));
      }
    });

    if (el.sidebarBackdrop) {
      el.sidebarBackdrop.addEventListener('click', () => {
        setSidebarOpen(false);
      });
    }

    if (el.mobileSearchBtn && el.topbar) {
      el.mobileSearchBtn.addEventListener('click', () => {
        el.topbar.classList.add('search-open');
        el.searchInput.focus();
      });
    }

    if (el.searchBackBtn && el.topbar) {
      el.searchBackBtn.addEventListener('click', () => {
        el.topbar.classList.remove('search-open');
      });
    }

    if (el.topChipBar) {
      el.topChipBar.addEventListener('scroll', updateChipScrollButtons, { passive: true });
    }
    if (el.chipPrevBtn) {
      el.chipPrevBtn.addEventListener('click', () => {
        el.topChipBar.scrollBy({ left: -240, behavior: 'smooth' });
      });
    }
    if (el.chipNextBtn) {
      el.chipNextBtn.addEventListener('click', () => {
        el.topChipBar.scrollBy({ left: 240, behavior: 'smooth' });
      });
    }

    window.addEventListener('resize', () => {
      if (!isOverlaySidebarViewport()) {
        el.sidebar.classList.remove('collapsed');
        if (el.sidebarBackdrop) el.sidebarBackdrop.hidden = true;
      } else if (!el.sidebar.classList.contains('collapsed')) {
        // Switching to narrower viewport: collapse overlay cleanly
        setSidebarOpen(false);
      }
      if (window.innerWidth > 599 && el.topbar) {
        el.topbar.classList.remove('search-open');
      }
      updateChipScrollButtons();
      if (state.view === 'calendar') {
        renderCalendarView();
      }
    });

    el.brandHomeLink.addEventListener('click', (e) => {
      e.preventDefault();
      state.q = '';
      state.tag = '';
      state.channelId = null;
      state.lang = 'all';
      el.searchInput.value = '';
      el.clearSearchBtn.hidden = true;
      switchView('series');
      renderSidebarChannels();
      renderDynamicTags();
      syncTopChipsActive();
      syncFilterBadge();
      loadSeries(false);
      history.pushState({}, '', '/');
    });

    document.querySelectorAll('.nav-item, .mobile-nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view;
        switchView(v);
        if (VIEW_PATHS[v]) pushPath(VIEW_PATHS[v]);
      });
    });

    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-route-link]');
      if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      const path = new URL(link.href).pathname;
      pushPath(path);
      applyRouteFromUrl(path);
    });

    if (el.views.about) {
      el.views.about.querySelector('.legal-toc')?.addEventListener('click', (e) => {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        e.preventDefault();
        document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth' });
      });
    }

    el.searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      state.q = el.searchInput.value.trim();
      el.clearSearchBtn.hidden = !state.q;
      if (el.topbar && !state.q) {
        el.topbar.classList.remove('search-open');
      }
      switchView('series');
      loadSeries(false);
    });

    el.searchInput.addEventListener('input', () => {
      el.clearSearchBtn.hidden = !el.searchInput.value;
    });

    el.clearSearchBtn.addEventListener('click', () => {
      el.searchInput.value = '';
      el.clearSearchBtn.hidden = true;
      state.q = '';
      loadSeries(false);
    });

    el.topChipBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      const lang = btn.dataset.lang;
      const tag = btn.dataset.tag;
      if (tag) {
        applyTagFilter(tag);
        return;
      }
      if (lang !== undefined && lang !== '') {
        state.lang = lang;
        state.tag = '';
        renderDynamicTags();
        syncTopChipsActive();
        syncFilterBadge();
        renderHomeShelves();
        loadSeries(false);
      }
    });

    el.sortSelect.addEventListener('change', () => {
      state.sort = el.sortSelect.value;
      loadSeries(false);
    });

    el.clearFiltersBtn.addEventListener('click', () => {
      state.channelId = null;
      state.channelName = '';
      state.tag = '';
      renderSidebarChannels();
      renderDynamicTags();
      syncTopChipsActive();
      syncFilterBadge();
      renderHomeShelves();
      loadSeries(false);
    });

    el.toggleCommentsCheckbox.addEventListener('change', () => {
      state.showCommentQuotes = el.toggleCommentsCheckbox.checked;
      renderHomeShelves();
    });

    el.sidebarChannels.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-channel-id]');
      if (!btn) return;
      const id = parseInt(btn.dataset.channelId, 10);
      state.channelId = state.channelId === id ? null : id;
      state.channelName = state.channelId ? btn.dataset.channelName : '';
      switchView('series');
      renderSidebarChannels();
      loadSeries(false);
    });

    el.channelsGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.browse-ch-btn');
      if (!btn) return;
      state.channelId = parseInt(btn.dataset.channelId, 10);
      state.channelName = btn.dataset.channelName;
      switchView('series');
      renderSidebarChannels();
      loadSeries(false);
    });

    if (el.calPrevWeekBtn) {
      el.calPrevWeekBtn.addEventListener('click', () => {
        state.calendar.weekOffset -= 1;
        state.calendar.selectedDayKey = null;
        loadCalendar();
      });
    }
    if (el.calTodayBtn) {
      el.calTodayBtn.addEventListener('click', () => {
        state.calendar.weekOffset = 0;
        state.calendar.selectedDayKey = null;
        loadCalendar();
      });
    }
    if (el.calNextWeekBtn) {
      el.calNextWeekBtn.addEventListener('click', () => {
        state.calendar.weekOffset += 1;
        state.calendar.selectedDayKey = null;
        loadCalendar();
      });
    }
    if (el.calChannelSelect) {
      el.calChannelSelect.addEventListener('change', () => {
        state.calendar.channelId = el.calChannelSelect.value;
        loadCalendar();
      });
    }
    if (el.calLangGroup) {
      el.calLangGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cal-lang]');
        if (!btn) return;
        state.calendar.lang = btn.dataset.calLang;
        el.calLangGroup.querySelectorAll('[data-cal-lang]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        loadCalendar();
      });
    }
    if (el.calWatchlistBtn) {
      el.calWatchlistBtn.addEventListener('click', () => {
        state.calendar.watchlistOnly = !state.calendar.watchlistOnly;
        el.calWatchlistBtn.classList.toggle('active', state.calendar.watchlistOnly);
        el.calWatchlistBtn.setAttribute('aria-pressed', state.calendar.watchlistOnly ? 'true' : 'false');
        renderCalendarView();
      });
    }
    if (el.calToggleSectionsBtn) {
      el.calToggleSectionsBtn.addEventListener('click', () => {
        const week = getLocalWeekInfo(state.calendar.weekOffset);
        const filteredItems = state.calendar.items.filter((it) =>
          state.calendar.watchlistOnly ? Boolean(it.seriesSlug && state.saved[it.seriesSlug]) : true
        );
        const countsByDay = new Map(week.days.map((d) => [d.key, 0]));
        for (const item of filteredItems) {
          const key = getLocalDayKey(new Date(item.airingAt * 1000));
          if (countsByDay.has(key)) countsByDay.set(key, countsByDay.get(key) + 1);
        }
        const useSingleDayMode = state.calendar.layout === 'day' || window.innerWidth < 960;
        const targetDays = useSingleDayMode
          ? week.days.filter((d) => d.key === state.calendar.selectedDayKey)
          : week.days;
        const allCollapsed =
          targetDays.length > 0 &&
          targetDays.every((d) => isCalendarSectionCollapsed(d.key, countsByDay.get(d.key) || 0));
        for (const d of targetDays) {
          state.calendar.collapsedDays[d.key] = !allCollapsed;
        }
        renderCalendarView();
      });
    }
    if (el.calLayoutGroup) {
      el.calLayoutGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cal-layout]');
        if (!btn) return;
        state.calendar.layout = btn.dataset.calLayout;
        el.calLayoutGroup.querySelectorAll('[data-cal-layout]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        renderCalendarView();
      });
    }
    if (el.calDayTabs) {
      el.calDayTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-cal-day]');
        if (!tab) return;
        state.calendar.selectedDayKey = tab.dataset.calDay;
        renderCalendarView();
      });
    }
    if (el.calendarGrid) {
      el.calendarGrid.addEventListener('click', (e) => {
        const expandListBtn = e.target.closest('[data-cal-expand-list]');
        if (expandListBtn) {
          e.stopPropagation();
          const dayKey = expandListBtn.dataset.calExpandList;
          state.calendar.expandedLists[dayKey] = !state.calendar.expandedLists[dayKey];
          renderCalendarView();
          return;
        }
        const sectionBtn = e.target.closest('[data-cal-section-toggle]');
        if (sectionBtn) {
          e.stopPropagation();
          const itemCount = parseInt(sectionBtn.dataset.calSectionCount || '0', 10) || 0;
          toggleCalendarSection(sectionBtn.dataset.calSectionToggle, itemCount);
          return;
        }
        const wlBtn = e.target.closest('[data-watchlist-toggle]');
        if (wlBtn) {
          e.stopPropagation();
          toggleWatchlistBySlug(wlBtn.dataset.watchlistToggle);
          return;
        }
        const card = e.target.closest('.cal-card[data-cal-id]');
        if (!card) return;
        const item = calendarItemsById.get(card.dataset.calId);
        if (!item) return;
        let targetUrl = '';
        if (item.seriesSlug) {
          const qs = item.youtubeVideoId ? `?v=${encodeURIComponent(item.youtubeVideoId)}` : '';
          targetUrl = `/watch/${encodeURIComponent(item.seriesSlug)}${qs}`;
        } else if (item.youtubeVideoId) {
          targetUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(item.youtubeVideoId)}`;
        }
        if (targetUrl) {
          window.open(targetUrl, '_blank', 'noopener,noreferrer');
        }
      });
    }

    if (el.loadMoreBtn) {
      el.loadMoreBtn.addEventListener('click', () => {
        if (state.isLoadingSeries) return;
        state.page += 1;
        loadSeries(true);
      });
    }

    if (el.clearHistoryBtn) {
      el.clearHistoryBtn.addEventListener('click', () => {
        if (window.confirm('Clear your entire watch history on this device?')) {
          clearAllHistory();
        }
      });
    }

    el.liveShelfGrid.addEventListener('click', (e) => {
      const card = e.target.closest('[data-live-vid]');
      if (!card) return;
      openLiveStreamWatch(card.dataset.liveVid);
    });

    [el.views.series, el.views.watchlist, el.views.history].forEach((viewNode) => {
      if (!viewNode) return;
      viewNode.addEventListener('click', (e) => {
        const watchlistBtn = e.target.closest('[data-watchlist-toggle]');
        if (watchlistBtn) {
          e.stopPropagation();
          toggleWatchlistBySlug(watchlistBtn.dataset.watchlistToggle);
          return;
        }
        const removeBtn = e.target.closest('[data-remove-history]');
        if (removeBtn) {
          e.stopPropagation();
          removeHistoryBySlug(removeBtn.dataset.removeHistory);
          return;
        }
        const tagBtn = e.target.closest('[data-tag-click]');
        if (tagBtn) {
          e.stopPropagation();
          applyTagFilter(tagBtn.dataset.tagClick);
          return;
        }
        const card = e.target.closest('.series-card[data-slug]');
        if (!card) return;
        openSeriesWatch(card.dataset.slug);
      });
    });

    el.watchDescTags.addEventListener('click', (e) => {
      const tagBtn = e.target.closest('[data-tag-click]');
      if (!tagBtn) return;
      applyTagFilter(tagBtn.dataset.tagClick);
    });

    el.toggleDescBtn.addEventListener('click', () => {
      const expanded = el.watchDescBox.classList.toggle('expanded');
      el.toggleDescBtn.textContent = expanded ? 'Fewer Details' : 'More Details';
    });

    el.backToBrowseBtn.addEventListener('click', () => {
      const targetView = state.watchReturnView === 'songs' ? 'songs' : 'series';
      switchView(targetView);
      history.pushState({}, '', VIEW_PATHS[targetView] || '/');
    });

    el.saveSeriesBtn.addEventListener('click', () => {
      if (!state.watch?.detail) return;
      const { series, sources } = state.watch.detail;
      if (state.saved[series.slug]) {
        delete state.saved[series.slug];
      } else {
        state.saved[series.slug] = toSavedEntry(
          series,
          sources.map((s) => ({ channelName: s.channelName, channelAvatar: s.channelAvatar }))
        );
      }
      saveJson(STORAGE_SAVED, state.saved);
      syncWatchlistButtonsForSlug(series.slug);
      renderWatchView();
    });

    el.sourceSwitcher.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-source-id]');
      if (!btn || !state.watch?.detail) return;
      state.watch.activeSourceId = parseInt(btn.dataset.sourceId, 10);
      state.watch.activeEpisodeIndex = 0;
      playActiveEpisode();
    });

    el.episodeList.addEventListener('click', (e) => {
      const songBtn = e.target.closest('[data-song-queue-index]');
      if (songBtn && state.watch?.songList) {
        state.watch.activeSongIndex = parseInt(songBtn.dataset.songQueueIndex, 10);
        playActiveSong();
        return;
      }
      const btn = e.target.closest('[data-ep-index]');
      if (!btn || !state.watch?.detail) return;
      state.watch.activeEpisodeIndex = parseInt(btn.dataset.epIndex, 10);
      playActiveEpisode();
    });

    if (el.songsTypeChips) {
      el.songsTypeChips.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-song-type]');
        if (!btn) return;
        state.songs.type = btn.dataset.songType || 'all';
        updateSongTypeChipCounts();
        loadSongs(false);
      });
    }
    if (el.songsSearchInput) {
      let songSearchTimer = null;
      el.songsSearchInput.addEventListener('input', () => {
        clearTimeout(songSearchTimer);
        songSearchTimer = setTimeout(() => {
          state.songs.q = el.songsSearchInput.value.trim();
          loadSongs(false);
        }, 250);
      });
    }
    if (el.songsChannelSelect) {
      el.songsChannelSelect.addEventListener('change', () => {
        state.songs.channelId = el.songsChannelSelect.value;
        loadSongs(false);
      });
    }
    if (el.songsSortSelect) {
      el.songsSortSelect.addEventListener('change', () => {
        state.songs.sort = el.songsSortSelect.value;
        loadSongs(false);
      });
    }
    if (el.songsLoadMoreBtn) {
      el.songsLoadMoreBtn.addEventListener('click', () => {
        if (state.songs.loading) return;
        state.songs.page += 1;
        loadSongs(true);
      });
    }
    if (el.songsLayoutGroup) {
      el.songsLayoutGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-songs-group]');
        if (!btn) return;
        const nextGroup = btn.dataset.songsGroup === 'anime' ? 'anime' : 'tracks';
        if (state.songs.group === nextGroup) return;
        state.songs.group = nextGroup;
        el.songsLayoutGroup.querySelectorAll('[data-songs-group]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        loadSongs(false);
      });
    }
    if (el.songsGrid) {
      el.songsGrid.addEventListener('click', (e) => {
        const groupCard = e.target.closest('.song-card[data-song-group-index]');
        if (groupCard) {
          openSongGroupWatch(parseInt(groupCard.dataset.songGroupIndex, 10));
          return;
        }
        const card = e.target.closest('.song-card[data-song-index]');
        if (!card) return;
        openSongWatch(parseInt(card.dataset.songIndex, 10));
      });
      el.songsGrid.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const groupCard = e.target.closest('.song-card[data-song-group-index]');
        if (groupCard) {
          e.preventDefault();
          openSongGroupWatch(parseInt(groupCard.dataset.songGroupIndex, 10));
          return;
        }
        const card = e.target.closest('.song-card[data-song-index]');
        if (!card) return;
        e.preventDefault();
        openSongWatch(parseInt(card.dataset.songIndex, 10));
      });
    }

    window.addEventListener('popstate', () => {
      applyRouteFromUrl(window.location.pathname);
    });

    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener('click', () => {
        const next = getActiveTheme() === 'light' ? 'dark' : 'light';
        applyTheme(next, true);
      });
    }

    if (typeof window.matchMedia === 'function') {
      const mql = window.matchMedia('(prefers-color-scheme: light)');
      mql.addEventListener?.('change', (e) => {
        try {
          const saved = localStorage.getItem(STORAGE_THEME);
          if (saved === 'light' || saved === 'dark') return;
        } catch {
          /* ignore */
        }
        applyTheme(e.matches ? 'light' : 'dark', false);
      });
    }
  }

  async function init() {
    applyTheme(getActiveTheme(), false);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    Object.values(state.saved).forEach(registerSeriesItem);
    Object.values(state.history).forEach((h) => registerSeriesItem(h?.series));

    if (isOverlaySidebarViewport()) {
      setSidebarOpen(false);
    }

    setupInfiniteScroll();
    bindEvents();
    state.region = await detectInitialRegion();
    await loadInitialMetadata();
    updateChipScrollButtons();
    await loadSeries(false);

    applyRouteFromUrl(window.location.pathname);
  }

  init().catch((err) => {
    console.error('AnimaxTube init failed:', err);
    el.seriesGrid.innerHTML = `<div class="empty-state">Failed to load data from server.</div>`;
  });
})();
