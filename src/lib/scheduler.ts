import { spawn, type ChildProcess } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

export interface QueuedJobInfo {
  id: string;
  label: string;
}

export interface RunQueuedNowResult {
  ok: boolean;
  startedOrPromoted: string | null;
  preemptedRunningJob: string | null;
}

export interface RemoveQueuedResult {
  ok: boolean;
  removedLabel: string | null;
}

export interface JobStatusSnapshot {
  runningJob: string | null;
  startedAt: number | null;
  lastFinishedJob: string | null;
  lastFinishedAt: number | null;
  lastExitCode: number | null;
  queuedCount: number;
  queuedJobs: QueuedJobInfo[];
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

export type SyncScope = 'both' | 'playlists' | 'videos';

export interface JobCoordinator {
  triggerLiveCheck: () => boolean;
  triggerChannelSync: (youtubeChannelId?: string, scope?: SyncScope) => boolean;
  triggerIncrementalSync: (scope?: SyncScope) => boolean;
  triggerFullSync: (scope?: SyncScope) => boolean;
  triggerSongSync: () => boolean;
  triggerDiscovery: () => boolean;
  runQueuedNow: (jobId?: string) => RunQueuedNowResult;
  removeQueuedJob: (jobId: string) => RemoveQueuedResult;
  getStatus: () => JobStatusSnapshot;
  stop: () => void;
}

function scopeCliArgs(scope?: SyncScope): string[] {
  if (scope === 'playlists') return ['--playlists-only'];
  if (scope === 'videos') return ['--videos-only'];
  if (scope === 'both') return ['--sync-both'];
  return [];
}

function scopeLabelSuffix(scope?: SyncScope): string {
  if (scope === 'playlists') return ' [playlists only]';
  if (scope === 'videos') return ' [videos only]';
  if (scope === 'both') return ' [playlists + videos]';
  return '';
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

  const pendingChannelJobs = new Map<string, { youtubeChannelId: string; scope?: SyncScope }>();
  let pendingUnsynced = false;
  let pendingDiscovery = false;
  let pendingFullSync: { queued: boolean; scope?: SyncScope } = { queued: false };
  let pendingIncremental: { queued: boolean; scope?: SyncScope } = { queued: false };
  let pendingSongSync = false;
  let pendingLive = false;
  let priorityJobId: string | null = null;

  const nowSec = () => Math.floor(Date.now() / 1000);
  let nextLiveAt: number | null = autoSyncEnabled && canSpawn ? nowSec() + 60 : null;
  let nextIncrementalAt: number | null = autoSyncEnabled && canSpawn ? nowSec() + incrementalHours * 3600 : null;
  let nextFullSyncAt: number | null = autoSyncEnabled && canSpawn ? nowSec() + channelHours * 3600 : null;
  let nextDiscoveryAt: number | null =
    autoSyncEnabled && canSpawn && discoveryHours > 0 ? nowSec() + discoveryHours * 3600 : null;

  const listQueuedJobs = (): QueuedJobInfo[] => {
    const list: QueuedJobInfo[] = [];
    for (const [key, job] of pendingChannelJobs.entries()) {
      list.push({
        id: `channel:${key}`,
        label: `channel sync (${job.youtubeChannelId}${scopeLabelSuffix(job.scope)})`,
      });
    }
    if (pendingUnsynced) {
      list.push({ id: 'unsynced', label: 'new channel backfill sync' });
    }
    if (pendingDiscovery) {
      list.push({ id: 'discovery', label: 'channel discovery scan' });
    }
    if (pendingFullSync.queued) {
      list.push({
        id: 'full',
        label: `daily full channel & episode sync${scopeLabelSuffix(pendingFullSync.scope)}`,
      });
    }
    if (pendingIncremental.queued) {
      list.push({
        id: 'incremental',
        label: `incremental episode sync (${incrementalHours}h)${scopeLabelSuffix(pendingIncremental.scope)}`,
      });
    }
    if (pendingSongSync) {
      list.push({ id: 'songs', label: 'anime songs sync (OP/ED/OST)' });
    }
    if (pendingLive) {
      list.push({ id: 'live', label: 'live & unlock check' });
    }
    if (priorityJobId) {
      const idx = list.findIndex((item) => item.id === priorityJobId);
      if (idx > 0) {
        const [promoted] = list.splice(idx, 1);
        list.unshift(promoted);
      }
    }
    return list;
  };

  const queuedCount = () =>
    pendingChannelJobs.size +
    (pendingUnsynced ? 1 : 0) +
    (pendingDiscovery ? 1 : 0) +
    (pendingFullSync.queued ? 1 : 0) +
    (pendingIncremental.queued ? 1 : 0) +
    (pendingSongSync ? 1 : 0) +
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

  const launchQueuedById = (id: string): boolean => {
    if (id.startsWith('channel:')) {
      const key = id.slice('channel:'.length);
      const job = pendingChannelJobs.get(key);
      if (!job) return false;
      pendingChannelJobs.delete(key);
      launchScript(
        'src/ingestion/sync-channels.ts',
        [`--channel=${job.youtubeChannelId}`, ...scopeCliArgs(job.scope)],
        `channel sync (${job.youtubeChannelId}${scopeLabelSuffix(job.scope)})`
      );
      return true;
    }
    if (id === 'unsynced' && pendingUnsynced) {
      pendingUnsynced = false;
      launchScript('src/ingestion/sync-channels.ts', ['--only-unsynced'], 'new channel backfill sync');
      return true;
    }
    if (id === 'discovery' && pendingDiscovery) {
      pendingDiscovery = false;
      launchScript('src/discovery/discover-channels.ts', [], 'channel discovery scan');
      return true;
    }
    if (id === 'full' && pendingFullSync.queued) {
      const scope = pendingFullSync.scope;
      pendingFullSync = { queued: false };
      pendingIncremental = { queued: false };
      launchScript(
        'src/ingestion/sync-channels.ts',
        scopeCliArgs(scope),
        `daily full channel & episode sync${scopeLabelSuffix(scope)}`
      );
      return true;
    }
    if (id === 'incremental' && pendingIncremental.queued) {
      const scope = pendingIncremental.scope;
      pendingIncremental = { queued: false };
      launchScript(
        'src/ingestion/sync-channels.ts',
        ['--incremental', ...scopeCliArgs(scope)],
        `incremental episode sync (${incrementalHours}h)${scopeLabelSuffix(scope)}`
      );
      return true;
    }
    if (id === 'songs' && pendingSongSync) {
      pendingSongSync = false;
      launchScript('src/ingestion/sync-songs.ts', [], 'anime songs sync (OP/ED/OST)');
      return true;
    }
    if (id === 'live' && pendingLive) {
      pendingLive = false;
      launchScript('src/tracking/live-and-unlocks.ts', [`--locked-limit=${lockedLimit}`], 'live & unlock check');
      return true;
    }
    return false;
  };

  const drainQueue = () => {
    if (stopped || !canSpawn || activeChild) return;

    if (priorityJobId) {
      const targetId = priorityJobId;
      priorityJobId = null;
      if (launchQueuedById(targetId)) return;
    }

    const nextEntry = pendingChannelJobs.entries().next().value as
      | [string, { youtubeChannelId: string; scope?: SyncScope }]
      | undefined;
    if (nextEntry) {
      launchQueuedById(`channel:${nextEntry[0]}`);
      return;
    }
    if (pendingUnsynced) {
      launchQueuedById('unsynced');
      return;
    }
    if (pendingDiscovery) {
      launchQueuedById('discovery');
      return;
    }
    if (pendingFullSync.queued) {
      launchQueuedById('full');
      return;
    }
    if (pendingIncremental.queued) {
      launchQueuedById('incremental');
      return;
    }
    if (pendingSongSync) {
      launchQueuedById('songs');
      return;
    }
    if (pendingLive) {
      launchQueuedById('live');
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
          if (overdue.fullOverdue) pendingFullSync = { queued: true };
          else if (overdue.incrementalOverdue) pendingIncremental = { queued: true };
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
        pendingIncremental = { queued: true };
      });
    }, incrementalHours * 3_600_000);
    incrementalTimer.unref();
    timers.push(incrementalTimer);

    const channelTimer = setInterval(() => {
      nextFullSyncAt = nowSec() + channelHours * 3600;
      enqueue(() => {
        pendingFullSync = { queued: true };
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
    triggerChannelSync: (youtubeChannelId?: string, scope?: SyncScope) =>
      enqueue(() => {
        if (youtubeChannelId) {
          const key = `${youtubeChannelId}:${scope || 'default'}`;
          pendingChannelJobs.set(key, { youtubeChannelId, scope });
        } else {
          pendingFullSync = { queued: true, scope };
        }
      }),
    triggerIncrementalSync: (scope?: SyncScope) =>
      enqueue(() => {
        pendingIncremental = { queued: true, scope };
      }),
    triggerFullSync: (scope?: SyncScope) =>
      enqueue(() => {
        pendingFullSync = { queued: true, scope };
      }),
    triggerSongSync: () =>
      enqueue(() => {
        pendingSongSync = true;
      }),
    triggerDiscovery: () =>
      enqueue(() => {
        pendingDiscovery = true;
      }),
    runQueuedNow: (jobId?: string): RunQueuedNowResult => {
      if (stopped || !canSpawn) {
        return { ok: false, startedOrPromoted: null, preemptedRunningJob: null };
      }
      const queued = listQueuedJobs();
      if (queued.length === 0) {
        return { ok: false, startedOrPromoted: null, preemptedRunningJob: null };
      }
      const target = jobId ? queued.find((q) => q.id === jobId) : queued[0];
      if (!target) {
        return { ok: false, startedOrPromoted: null, preemptedRunningJob: null };
      }
      priorityJobId = target.id;
      if (activeChild) {
        const preempted = runningJob;
        const childToStop = activeChild;
        childToStop.kill('SIGTERM');
        const killFallback = setTimeout(() => {
          if (activeChild === childToStop) {
            childToStop.kill('SIGKILL');
          }
        }, 5000);
        killFallback.unref();
        return { ok: true, startedOrPromoted: target.label, preemptedRunningJob: preempted };
      }
      drainQueue();
      return { ok: true, startedOrPromoted: target.label, preemptedRunningJob: null };
    },
    removeQueuedJob: (jobId: string): RemoveQueuedResult => {
      const queued = listQueuedJobs();
      const target = queued.find((q) => q.id === jobId);
      if (!target) {
        return { ok: false, removedLabel: null };
      }
      if (jobId.startsWith('channel:')) {
        pendingChannelJobs.delete(jobId.slice('channel:'.length));
      } else if (jobId === 'unsynced') {
        pendingUnsynced = false;
      } else if (jobId === 'discovery') {
        pendingDiscovery = false;
      } else if (jobId === 'full') {
        pendingFullSync = { queued: false };
      } else if (jobId === 'incremental') {
        pendingIncremental = { queued: false };
      } else if (jobId === 'songs') {
        pendingSongSync = false;
      } else if (jobId === 'live') {
        pendingLive = false;
      }
      if (priorityJobId === jobId) {
        priorityJobId = null;
      }
      return { ok: true, removedLabel: target.label };
    },
    getStatus: () => ({
      runningJob,
      startedAt,
      lastFinishedJob,
      lastFinishedAt,
      lastExitCode,
      queuedCount: queuedCount(),
      queuedJobs: listQueuedJobs(),
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
