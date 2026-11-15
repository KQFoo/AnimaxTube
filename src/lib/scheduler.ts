import { spawn, type ChildProcess } from 'node:child_process';

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Lightweight single-container background job runner for Railway/Docker deployments
 * where a persistent SQLite volume is attached to only one container.
 * Uses child processes so ingestion memory is reclaimed immediately after each run.
 */
export function startBackgroundSyncScheduler(): SchedulerHandle {
  const enabled = process.env.ENABLE_AUTO_SYNC === 'true';
  const dbPath = process.env.DB_PATH || '';
  if (!enabled || dbPath === ':memory:') {
    return { stop: () => {} };
  }

  const liveMinutes = Math.max(5, parseInt(process.env.LIVE_SYNC_INTERVAL_MIN || '30', 10) || 30);
  const channelHours = Math.max(6, parseInt(process.env.CHANNEL_SYNC_INTERVAL_HOURS || '24', 10) || 24);
  const lockedLimit = Math.max(10, parseInt(process.env.LIVE_LOCKED_LIMIT || '250', 10) || 250);

  let stopped = false;
  let activeChild: ChildProcess | null = null;
  let pendingChannelSync = false;

  const runScript = (scriptRelPath: string, args: string[], label: string): Promise<void> => {
    if (stopped || activeChild) return Promise.resolve();

    return new Promise((resolve) => {
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

      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (activeChild === child) activeChild = null;
        console.log(`[scheduler] ${label} finished (code=${code}, signal=${signal ?? 'none'}).`);
        resolve();
      });

      child.once('error', (err) => {
        clearTimeout(timeout);
        if (activeChild === child) activeChild = null;
        console.error(`[scheduler] ${label} failed to launch:`, err.message);
        resolve();
      });
    });
  };

  const hasApiKey = Boolean((process.env.YOUTUBE_API_KEY || '').trim());
  if (!hasApiKey) {
    console.warn('[scheduler] ENABLE_AUTO_SYNC=true but YOUTUBE_API_KEY is missing; skipping scheduled jobs.');
    return { stop: () => {} };
  }

  const runNext = async (preferChannelSync: boolean) => {
    if (stopped) return;
    if (activeChild) {
      if (preferChannelSync) pendingChannelSync = true;
      return;
    }

    if (preferChannelSync || pendingChannelSync) {
      pendingChannelSync = false;
      await runScript('src/ingestion/sync-channels.ts', [], 'daily channel & episode sync');
    } else {
      await runScript('src/tracking/live-and-unlocks.ts', [`--locked-limit=${lockedLimit}`], 'live & unlock check');
    }
  };

  const warmupTimer = setTimeout(() => {
    void runNext(false);
  }, 60_000);
  warmupTimer.unref();

  const liveTimer = setInterval(() => {
    void runNext(false);
  }, liveMinutes * 60_000);
  liveTimer.unref();

  const channelTimer = setInterval(() => {
    void runNext(true);
  }, channelHours * 3_600_000);
  channelTimer.unref();

  console.log(
    `[scheduler] Enabled: live/unlocks every ${liveMinutes}m (--locked-limit=${lockedLimit}), full sync every ${channelHours}h.`
  );

  return {
    stop: () => {
      stopped = true;
      clearTimeout(warmupTimer);
      clearInterval(liveTimer);
      clearInterval(channelTimer);
      if (activeChild) {
        activeChild.kill('SIGTERM');
      }
    },
  };
}
