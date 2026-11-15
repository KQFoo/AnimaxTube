import { spawn, type ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

export interface JobStatusSnapshot {
  runningJob: string | null;
  startedAt: number | null;
  lastFinishedJob: string | null;
  lastFinishedAt: number | null;
  lastExitCode: number | null;
  queuedCount: number;
  autoSyncEnabled: boolean;
  hasYouTubeApiKey: boolean;
  intervals: {
    liveMinutes: number;
    incrementalHours: number;
    channelHours: number;
    discoveryHours: number;
  };
  nextRunAt: {
    liveAt: number | null;
    incrementalAt: number | null;
    fullSyncAt: number | null;
    discoveryAt: number | null;
  };
}

export interface JobCoordinator {
  triggerLiveCheck: () => boolean;
  triggerChannelSync: (youtubeChannelId?: string) => boolean;
  triggerIncrementalSync: () => boolean;
  triggerFullSync: () => boolean;
  triggerDiscovery: () => boolean;
  getStatus: () => JobStatusSnapshot;
  stop: () => void;
}

function hasYouTubeApiKey(): boolean {
  return Boolean((process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEYS || '').trim());
}

function readOverdueFlags(
  db: DatabaseSync,
  incrementalSec: number,
  fullSec: number,
  discoverySec: number
): { unsynced: boolean; incrementalOverdue: boolean; fullOverdue: boolean; discoveryOverdue: boolean } {
  const now = Math.floor(Date.now() / 1000);
  const channelStats = db
    .prepare(
      `SELECT COUNT(*) AS verified_cnt,
              SUM(CASE WHEN last_synced_at IS NULL THEN 1 ELSE 0 END) AS unsynced_cnt,
              MAX(COALESCE(last_synced_at, 0)) AS newest_sync
       FROM channels
       WHERE is_verified = 1`
    )
    .get() as { verified_cnt: number; unsynced_cnt: number | null; newest_sync: number | null };

  if (!channelStats || channelStats.verified_cnt === 0) {
    return { unsynced: false, incrementalOverdue: false, fullOverdue: false, discoveryOverdue: false };
  }

  const fullFlag = db
    .prepare("SELECT dirty FROM cache_flags WHERE key = 'last_full_sync_at'")
    .get() as { dirty: number } | undefined;
  const discFlag = db
    .prepare("SELECT dirty FROM cache_flags WHERE key = 'last_discovery_at'")
    .get() as { dirty: number } | undefined;

  const newestSync = channelStats.newest_sync || 0;
  const lastFull = fullFlag?.dirty || newestSync;
  const lastDiscovery = discFlag?.dirty || newestSync;

  return {
    unsynced: (channelStats.unsynced_cnt || 0) > 0,
    incrementalOverdue: newestSync > 0 && now - newestSync >= incrementalSec,
    fullOverdue: lastFull > 0 && now - lastFull >= fullSec,
    discoveryOverdue: discoverySec > 0 && lastDiscovery > 0 && now - lastDiscovery >= discoverySec,
  };
}

/**
 * Coordinates single-writer background jobs (live tracker, incremental N-hour sync,
 * full daily sweep, weekly candidate discovery, and on-demand /admin actions)
 * using child processes so memory is reclaimed cleanly after each run.
 */
export function startBackgroundSyncScheduler(db?: DatabaseSync): JobCoordinator {
  const autoSyncEnabled = process.env.ENABLE_AUTO_SYNC === 'true';
  const dbPath = process.env.DB_PATH || '';
  const canSpawn = dbPath !== ':memory:' && hasYouTubeApiKey();

  const liveMinutes = Math.max(5, parseInt(process.env.LIVE_SYNC_INTERVAL_MIN || '30', 10) || 30);
  const incrementalHours = Math.max(1, parseInt(process.env.INCREMENTAL_SYNC_INTERVAL_HOURS || '4', 10) || 4);
  const channelHours = Math.max(6, parseInt(process.env.CHANNEL_SYNC_INTERVAL_HOURS || '24', 10) || 24);
  const rawDisc = process.env.CHANNEL_DISCOVERY_INTERVAL_HOURS;
  const parsedDisc = rawDisc === undefined ? 168 : parseInt(rawDisc, 10);
  const discoveryHours = Number.isFinite(parsedDisc) && parsedDisc > 0 ? Math.max(24, parsedDisc) : 0;
  const lockedLimit = Math.max(10, parseInt(process.env.LIVE_LOCKED_LIMIT || '250', 10) || 250);

  let stopped = false;
  let activeChild: ChildProcess | null = null;
  let runningJob: string | null = null;
  let startedAt: number | null = null;
  let lastFinishedJob: string | null = null;
  let lastFinishedAt: number | null = null;
  let lastExitCode: number | null = null;

  const pendingChannelIds = new Set<string>();
  let pendingUnsynced = false;
  let pendingDiscovery = false;
  let pendingFullSync = false;
  let pendingIncremental = false;
  let pendingLive = false;

  const nowSec = () => Math.floor(Date.now() / 1000);
  let nextLiveAt: number | null = autoSyncEnabled && canSpawn ? nowSec() + 60 : null;
  let nextIncrementalAt: number | null = autoSyncEnabled && canSpawn ? nowSec() + incrementalHours * 3600 : null;
  let nextFullSyncAt: number | null = autoSyncEnabled && canSpawn ? nowSec() + channelHours * 3600 : null;
  let nextDiscoveryAt: number | null =
    autoSyncEnabled && canSpawn && discoveryHours > 0 ? nowSec() + discoveryHours * 3600 : null;

  const queuedCount = () =>
    pendingChannelIds.size +
    (pendingUnsynced ? 1 : 0) +
    (pendingDiscovery ? 1 : 0) +
    (pendingFullSync ? 1 : 0) +
    (pendingIncremental ? 1 : 0) +
    (pendingLive ? 1 : 0);

  const launchScript = (scriptRelPath: string, args: string[], label: string) => {
    if (stopped || !canSpawn || activeChild) return;

    runningJob = label;
    startedAt = Math.floor(Date.now() / 1000);
    console.log(`[scheduler] Starting ${label}...`);

    const child = spawn(process.execPath, [scriptRelPath, ...args], {
      env: process.env,
      stdio: 'inherit',
    });
    activeChild = child;

    const timeout = setTimeout(() => {
      if (activeChild === child) {
        console.warn(`[scheduler] ${label} timed out; terminating.`);
        child.kill('SIGTERM');
      }
    }, 20 * 60 * 1000);
    timeout.unref();

    const finish = (code: number | null, signal: string | null) => {
      clearTimeout(timeout);
      if (activeChild === child) {
        activeChild = null;
        lastFinishedJob = label;
        lastFinishedAt = Math.floor(Date.now() / 1000);
        lastExitCode = code;
        runningJob = null;
        startedAt = null;
      }
      console.log(`[scheduler] ${label} finished (code=${code}, signal=${signal ?? 'none'}).`);
      drainQueue();
    };

    child.once('exit', (code, signal) => finish(code, signal));
    child.once('error', (err) => {
      console.error(`[scheduler] ${label} failed to launch:`, err.message);
      finish(1, null);
    });
  };

  const drainQueue = () => {
    if (stopped || !canSpawn || activeChild) return;

    const nextCh = pendingChannelIds.values().next().value as string | undefined;
    if (nextCh) {
      pendingChannelIds.delete(nextCh);
      launchScript('src/ingestion/sync-channels.ts', [`--channel=${nextCh}`], `channel sync (${nextCh})`);
      return;
    }
    if (pendingUnsynced) {
      pendingUnsynced = false;
      launchScript('src/ingestion/sync-channels.ts', ['--only-unsynced'], 'new channel backfill sync');
      return;
    }
    if (pendingDiscovery) {
      pendingDiscovery = false;
      launchScript('src/discovery/discover-channels.ts', [], 'channel discovery scan');
      return;
    }
    if (pendingFullSync) {
      pendingFullSync = false;
      pendingIncremental = false;
      launchScript('src/ingestion/sync-channels.ts', [], 'daily full channel & episode sync');
      return;
    }
    if (pendingIncremental) {
      pendingIncremental = false;
      launchScript('src/ingestion/sync-channels.ts', ['--incremental'], `incremental episode sync (${incrementalHours}h)`);
      return;
    }
    if (pendingLive) {
      pendingLive = false;
      launchScript('src/tracking/live-and-unlocks.ts', [`--locked-limit=${lockedLimit}`], 'live & unlock check');
    }
  };

  const enqueue = (fn: () => void): boolean => {
    if (stopped || !canSpawn) return false;
    fn();
    drainQueue();
    return true;
  };

  const timers: Array<ReturnType<typeof setTimeout>> = [];

  if (autoSyncEnabled && canSpawn) {
    const warmupTimer = setTimeout(() => {
      if (db) {
        try {
          const overdue = readOverdueFlags(
            db,
            incrementalHours * 3600,
            channelHours * 3600,
            discoveryHours * 3600
          );
          if (overdue.unsynced) pendingUnsynced = true;
          if (overdue.fullOverdue) pendingFullSync = true;
          else if (overdue.incrementalOverdue) pendingIncremental = true;
          if (overdue.discoveryOverdue) pendingDiscovery = true;
        } catch (err) {
          console.warn('[scheduler] Startup overdue check failed:', err instanceof Error ? err.message : err);
        }
      }
      nextLiveAt = nowSec() + liveMinutes * 60;
      pendingLive = true;
      drainQueue();
    }, 60_000);
    warmupTimer.unref();
    timers.push(warmupTimer);

    const liveTimer = setInterval(() => {
      nextLiveAt = nowSec() + liveMinutes * 60;
      enqueue(() => {
        pendingLive = true;
      });
    }, liveMinutes * 60_000);
    liveTimer.unref();
    timers.push(liveTimer);

    const incrementalTimer = setInterval(() => {
      nextIncrementalAt = nowSec() + incrementalHours * 3600;
      enqueue(() => {
        pendingIncremental = true;
      });
    }, incrementalHours * 3_600_000);
    incrementalTimer.unref();
    timers.push(incrementalTimer);

    const channelTimer = setInterval(() => {
      nextFullSyncAt = nowSec() + channelHours * 3600;
      enqueue(() => {
        pendingFullSync = true;
      });
    }, channelHours * 3_600_000);
    channelTimer.unref();
    timers.push(channelTimer);

    if (discoveryHours > 0) {
      const discoveryTimer = setInterval(() => {
        nextDiscoveryAt = nowSec() + discoveryHours * 3600;
        enqueue(() => {
          pendingDiscovery = true;
        });
      }, discoveryHours * 3_600_000);
      discoveryTimer.unref();
      timers.push(discoveryTimer);
    }

    console.log(
      `[scheduler] Enabled: live/unlocks every ${liveMinutes}m (--locked-limit=${lockedLimit}), incremental every ${incrementalHours}h, full sync every ${channelHours}h${discoveryHours > 0 ? `, discovery scan every ${discoveryHours}h` : ''}.`
    );
  } else if (autoSyncEnabled && !hasYouTubeApiKey()) {
    console.warn('[scheduler] ENABLE_AUTO_SYNC=true but YOUTUBE_API_KEY is missing; skipping scheduled jobs.');
  }

  return {
    triggerLiveCheck: () =>
      enqueue(() => {
        pendingLive = true;
      }),
    triggerChannelSync: (youtubeChannelId?: string) =>
      enqueue(() => {
        if (youtubeChannelId) pendingChannelIds.add(youtubeChannelId);
        else pendingFullSync = true;
      }),
    triggerIncrementalSync: () =>
      enqueue(() => {
        pendingIncremental = true;
      }),
    triggerFullSync: () =>
      enqueue(() => {
        pendingFullSync = true;
      }),
    triggerDiscovery: () =>
      enqueue(() => {
        pendingDiscovery = true;
      }),
    getStatus: () => ({
      runningJob,
      startedAt,
      lastFinishedJob,
      lastFinishedAt,
      lastExitCode,
      queuedCount: queuedCount(),
      autoSyncEnabled,
      hasYouTubeApiKey: hasYouTubeApiKey(),
      intervals: {
        liveMinutes,
        incrementalHours,
        channelHours,
        discoveryHours,
      },
      nextRunAt: {
        liveAt: nextLiveAt,
        incrementalAt: nextIncrementalAt,
        fullSyncAt: nextFullSyncAt,
        discoveryAt: nextDiscoveryAt,
      },
    }),
    stop: () => {
      stopped = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      if (activeChild) {
        activeChild.kill('SIGTERM');
      }
    },
  };
}
