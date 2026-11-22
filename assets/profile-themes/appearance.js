// The server owns the preference. This small cache is used before first paint.
(() => {
  const key = 'remediumAppearance';
  const themes = new Set(['zero-two', 'hello-kitty-pink', 'nefertiti', 'sakura-night']);
  function cached() {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function apply(theme, remember = false) {
    const root = document.documentElement;
    if (themes.has(theme)) root.dataset.siteTheme = theme;
    else delete root.dataset.siteTheme;
    if (remember && themes.has(theme) && theme !== cached()) {
      try { localStorage.setItem(key, theme); } catch {}
    }
  }
  apply(cached());
  window.CinemaAppearance = { key, cached, apply };
})();
