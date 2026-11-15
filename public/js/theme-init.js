(() => {
  try {
    const saved = localStorage.getItem('animaxtube_theme_v1');
    const prefersLight =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    const theme = saved === 'light' || saved === 'dark' ? saved : prefersLight ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#000000');
  } catch {
    /* ignore */
  }
})();
