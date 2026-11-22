// Reserved for future themes. Default is always active for every account.
(() => {
  const prefix = 'remediumAppearance:';
  function apply() { delete document.documentElement.dataset.siteTheme; }
  function setAccount(_id) { apply(); }
  function cached() { return null; }
  apply();
  window.CinemaAppearance = {key:prefix,cached,apply,setAccount};
})();
