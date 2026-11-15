(function () {
  let ytReadyPromise = null;
  let player = null;
  let onEndedCallback = null;

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
      },
      events: {
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
