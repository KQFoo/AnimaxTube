(function () {
  let ytReadyPromise = null;
  let player = null;
  let onEndedCallback = null;
  let activeMountId = null;
  let lockedLandscape = false;
  let lockSeq = 0;
  let fullscreenListenersBound = false;

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  function isMobileView() {
    const minDim = Math.min(window.innerWidth, window.innerHeight);
    const maxDim = Math.max(window.innerWidth, window.innerHeight);
    if (minDim <= 768) return true;
    const isCoarse =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
    return isCoarse && maxDim <= 1024;
  }

  function isPlayerFullscreenTarget(fsEl) {
    if (!fsEl) return false;
    if (activeMountId && fsEl.id === activeMountId) return true;
    try {
      const iframe = player?.getIframe?.();
      if (iframe && (fsEl === iframe || fsEl.contains(iframe))) return true;
    } catch {
      /* ignore */
    }
    return Boolean(fsEl.closest && fsEl.closest('.player-frame'));
  }

  async function lockHorizontal() {
    const orientation = window.screen && window.screen.orientation;
    if (!orientation || typeof orientation.lock !== 'function') return;
    const seq = ++lockSeq;
    try {
      await orientation.lock('landscape');
      if (seq === lockSeq && getFullscreenElement()) {
        lockedLandscape = true;
      } else if (typeof orientation.unlock === 'function') {
        orientation.unlock();
      }
    } catch {
      if (seq === lockSeq) lockedLandscape = false;
    }
  }

  function restoreVertical() {
    lockSeq++;
    if (!lockedLandscape) return;
    lockedLandscape = false;
    const orientation = window.screen && window.screen.orientation;
    if (!orientation || typeof orientation.unlock !== 'function') return;
    try {
      orientation.unlock();
    } catch {
      /* ignore */
    }
  }

  function exitPlayerFullscreenIfActive() {
    const fsEl = getFullscreenElement();
    if (fsEl && isPlayerFullscreenTarget(fsEl)) {
      const exitFn =
        document.exitFullscreen ||
        document.webkitExitFullscreen ||
        document.mozCancelFullScreen ||
        document.msExitFullscreen;
      if (typeof exitFn === 'function') {
        try {
          Promise.resolve(exitFn.call(document)).catch(() => {});
        } catch {
          /* ignore */
        }
      }
    }
    restoreVertical();
  }

  function handleFullscreenChange() {
    const fsEl = getFullscreenElement();
    if (fsEl) {
      if (isPlayerFullscreenTarget(fsEl) && isMobileView()) {
        lockHorizontal();
      }
    } else {
      restoreVertical();
    }
  }

  function bindFullscreenOrientationSync() {
    if (fullscreenListenersBound || typeof document === 'undefined') return;
    fullscreenListenersBound = true;
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
  }

  function ensureYouTubeApi() {
    if (ytReadyPromise) return ytReadyPromise;
    ytReadyPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) {
        resolve(window.YT);
        return;
      }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve(window.YT);
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    });
    return ytReadyPromise;
  }

  let generation = 0;

  async function playVideo(mountId, videoId, onEnded) {
    activeMountId = mountId;
    bindFullscreenOrientationSync();
    onEndedCallback = onEnded || null;
    const myGeneration = ++generation;
    const YT = await ensureYouTubeApi();
    if (myGeneration !== generation) return null;
    if (player && typeof player.loadVideoById === 'function') {
      player.loadVideoById(videoId);
      return player;
    }
    player = new YT.Player(mountId, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 1,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        fs: 1,
      },
      events: {
        onReady: (event) => {
          try {
            const iframe = event.target?.getIframe?.();
            if (iframe) {
              iframe.setAttribute('allowfullscreen', '');
              iframe.allow = 'autoplay; fullscreen; picture-in-picture';
            }
          } catch {
            /* ignore */
          }
        },
        onStateChange: (event) => {
          if (event.data === YT.PlayerState.ENDED && typeof onEndedCallback === 'function') {
            onEndedCallback();
          }
        },
      },
    });
    return player;
  }

  function stopVideo() {
    exitPlayerFullscreenIfActive();
    if (player && typeof player.stopVideo === 'function') {
      try {
        player.stopVideo();
      } catch {
        /* ignore */
      }
    }
  }

  /** Removes the YouTube iframe entirely and restores an empty mount node. */
  function destroy(mountId, container) {
    generation++;
    onEndedCallback = null;
    exitPlayerFullscreenIfActive();
    if (player) {
      try {
        player.destroy();
      } catch {
        /* ignore */
      }
      player = null;
    }
    if (container) {
      container.querySelectorAll('iframe').forEach((f) => f.remove());
      if (!document.getElementById(mountId)) {
        const mount = document.createElement('div');
        mount.id = mountId;
        container.prepend(mount);
      }
    }
  }

  window.AnimaxPlayer = { playVideo, stopVideo, destroy };
})();
