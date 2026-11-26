// Loaded in <head>, before the stylesheet paints, so a chosen theme never flashes
// the other one. "system" follows the device; "light" and "dark" pin it with
// <html data-theme>; the stylesheet does the rest. The `dark` class says which
// one shows, for scripts (the notices' theme). The app calls lingolensTheme
// when the choice changes or arrives from the profile.
(function () {
  var KEY = 'lingolens.theme';
  var BAR = { light: '#fafaf9', dark: '#141415' }; // matches --background
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var current = 'system';

  function paint() {
    var root = document.documentElement;
    var dark = current === 'dark' || (current === 'system' && !!media && media.matches);
    root.classList.toggle('dark', dark);
    // Browser chrome (mobile address bar, form controls) follows the same choice.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var forDark = /dark/.test(metas[i].media);
      metas[i].content = current === 'system' ? BAR[forDark ? 'dark' : 'light'] : BAR[current];
    }
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = current === 'system' ? 'light dark' : current;
  }

  function applyTheme(theme) {
    current = theme === 'light' || theme === 'dark' ? theme : 'system';
    var root = document.documentElement;
    if (current === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', current);
    paint();
    try { localStorage.setItem(KEY, current); } catch (e) { /* private mode */ }
    return current;
  }

  if (media) {
    var follow = function () { if (current === 'system') paint(); };
    if (media.addEventListener) media.addEventListener('change', follow);
    else if (media.addListener) media.addListener(follow);
  }

  var saved = 'system';
  try { saved = localStorage.getItem(KEY) || 'system'; } catch (e) { /* ignore */ }
  applyTheme(saved);
  window.lingolensTheme = applyTheme;
})();
