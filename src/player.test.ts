import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

interface MockEnvOptions {
  innerWidth: number;
  innerHeight: number;
  coarsePointer?: boolean;
  lockShouldReject?: boolean;
}

function loadPlayerInMockEnv(opts: MockEnvOptions) {
  const listeners = new Map<string, Set<() => void>>();
  const lockCalls: string[] = [];
  let unlockCalls = 0;
  let exitFullscreenCalls = 0;
  let destroyCalls = 0;
  let stopVideoCalls = 0;

  const iframeEl = {
    id: 'ytPlayerMount',
    attributes: new Map<string, string>(),
    allow: '',
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    contains(target: unknown) {
      return target === this;
    },
    closest(selector: string) {
      return selector === '.player-frame' ? playerFrameEl : null;
    },
  };

  const playerFrameEl = {
    className: 'player-frame',
    querySelectorAll() {
      return [];
    },
    prepend() {},
  };

  const doc = {
    fullscreenElement: null as unknown,
    webkitFullscreenElement: null as unknown,
    head: { appendChild() {} },
    getElementById(id: string) {
      return id === 'ytPlayerMount' ? iframeEl : null;
    },
    createElement() {
      return { id: '', src: '' };
    },
    addEventListener(event: string, fn: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    exitFullscreen() {
      exitFullscreenCalls += 1;
      doc.fullscreenElement = null;
      dispatch('fullscreenchange');
      return Promise.resolve();
    },
  };

  function dispatch(event: string) {
    for (const fn of listeners.get(event) ?? []) {
      fn();
    }
  }

  class MockYTPlayer {
    constructor(_mountId: string, config: { events?: { onReady?: (e: { target: MockYTPlayer }) => void } }) {
      config.events?.onReady?.({ target: this });
    }
    getIframe() {
      return iframeEl;
    }
    loadVideoById() {}
    stopVideo() {
      stopVideoCalls += 1;
    }
    destroy() {
      destroyCalls += 1;
    }
  }

  const win: Record<string, unknown> = {
    innerWidth: opts.innerWidth,
    innerHeight: opts.innerHeight,
    matchMedia(query: string) {
      return {
        matches: query.includes('pointer: coarse') ? Boolean(opts.coarsePointer) : false,
      };
    },
    screen: {
      orientation: {
        lock(mode: string) {
          lockCalls.push(mode);
          if (opts.lockShouldReject) {
            return Promise.reject(new DOMException('Not supported', 'NotSupportedError'));
          }
          return Promise.resolve();
        },
        unlock() {
          unlockCalls += 1;
        },
      },
    },
    YT: {
      Player: MockYTPlayer,
      PlayerState: { ENDED: 0 },
    },
  };

  const code = fs.readFileSync(path.resolve(process.cwd(), 'public/js/player.js'), 'utf8');
  const context = vm.createContext({
    window: win,
    document: doc,
    Promise,
    console,
  });
  vm.runInContext(code, context);

  return {
    playerApi: win.AnimaxPlayer as {
      playVideo: (mountId: string, videoId: string, onEnded?: () => void) => Promise<unknown>;
      stopVideo: () => void;
      destroy: (mountId: string, container?: unknown) => void;
    },
    win,
    doc,
    iframeEl,
    playerFrameEl,
    dispatch,
    getStats: () => ({
      lockCalls: [...lockCalls],
      unlockCalls,
      exitFullscreenCalls,
      destroyCalls,
      stopVideoCalls,
    }),
  };
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('mobile view locks landscape on player fullscreen and unlocks back to vertical on exit', async () => {
  const env = loadPlayerInMockEnv({ innerWidth: 390, innerHeight: 844, coarsePointer: true });
  await env.playerApi.playVideo('ytPlayerMount', 'abc123');

  // Enter fullscreen on the YouTube player iframe
  env.doc.fullscreenElement = env.iframeEl;
  env.dispatch('fullscreenchange');
  await flushAsync();

  assert.deepEqual(env.getStats().lockCalls, ['landscape']);
  assert.equal(env.getStats().unlockCalls, 0);

  // Viewport is now landscape (844x390) when user clicks exit fullscreen
  env.win.innerWidth = 844;
  env.win.innerHeight = 390;
  env.doc.fullscreenElement = null;
  env.dispatch('fullscreenchange');

  assert.equal(env.getStats().unlockCalls, 1);
});

test('desktop view does not lock orientation on fullscreen', async () => {
  const env = loadPlayerInMockEnv({ innerWidth: 1440, innerHeight: 900, coarsePointer: false });
  await env.playerApi.playVideo('ytPlayerMount', 'abc123');

  env.doc.fullscreenElement = env.iframeEl;
  env.dispatch('fullscreenchange');
  await flushAsync();

  assert.deepEqual(env.getStats().lockCalls, []);

  env.doc.fullscreenElement = null;
  env.dispatch('fullscreenchange');
  assert.equal(env.getStats().unlockCalls, 0);
});

test('non-player fullscreen element does not lock orientation', async () => {
  const env = loadPlayerInMockEnv({ innerWidth: 390, innerHeight: 844, coarsePointer: true });
  await env.playerApi.playVideo('ytPlayerMount', 'abc123');

  env.doc.fullscreenElement = { id: 'otherEl' };
  env.dispatch('fullscreenchange');
  await flushAsync();

  assert.deepEqual(env.getStats().lockCalls, []);
});

test('stopVideo and destroy exit active fullscreen and unlock orientation', async () => {
  const env = loadPlayerInMockEnv({ innerWidth: 390, innerHeight: 844, coarsePointer: true });
  await env.playerApi.playVideo('ytPlayerMount', 'abc123');

  env.doc.fullscreenElement = env.iframeEl;
  env.dispatch('fullscreenchange');
  await flushAsync();

  env.playerApi.stopVideo();
  assert.equal(env.getStats().exitFullscreenCalls, 1);
  assert.equal(env.getStats().unlockCalls, 1);
  assert.equal(env.getStats().stopVideoCalls, 1);

  env.doc.fullscreenElement = env.iframeEl;
  env.dispatch('fullscreenchange');
  await flushAsync();

  env.playerApi.destroy('ytPlayerMount', env.playerFrameEl);
  assert.equal(env.getStats().exitFullscreenCalls, 2);
  assert.equal(env.getStats().unlockCalls, 2);
  assert.equal(env.getStats().destroyCalls, 1);
});

test('unsupported screen.orientation.lock rejects gracefully without error', async () => {
  const env = loadPlayerInMockEnv({
    innerWidth: 390,
    innerHeight: 844,
    coarsePointer: true,
    lockShouldReject: true,
  });
  await env.playerApi.playVideo('ytPlayerMount', 'abc123');

  env.doc.fullscreenElement = env.iframeEl;
  env.dispatch('fullscreenchange');
  await flushAsync();

  assert.deepEqual(env.getStats().lockCalls, ['landscape']);

  env.doc.fullscreenElement = null;
  env.dispatch('fullscreenchange');
  assert.equal(env.getStats().unlockCalls, 0);
});
