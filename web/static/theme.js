// Loaded in <head>, before the stylesheet paints, so a chosen theme never flashes
// the other one. "system" follows the device (prefers-color-scheme in style.css);
// "light" and "dark" pin it with <html data-theme>. app.js calls applyTheme when
// the choice changes or arrives from the profile.
(function () {
  var KEY = 'lingolens.theme';
  var BAR = { light: '#fafafa', dark: '#1c1b19' }; // matches --canvas

  function applyTheme(theme) {
    var t = theme === 'light' || theme === 'dark' ? theme : 'system';
    var root = document.documentElement;
    if (t === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);

    // Browser chrome (mobile address bar, form controls) follows the same choice.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var dark = /dark/.test(metas[i].media);
      metas[i].content = t === 'system' ? BAR[dark ? 'dark' : 'light'] : BAR[t];
    }
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = t === 'system' ? 'light dark' : t;

    try { localStorage.setItem(KEY, t); } catch (e) { /* private mode */ }
    return t;
  }

  var saved = 'system';
  try { saved = localStorage.getItem(KEY) || 'system'; } catch (e) { /* ignore */ }
  applyTheme(saved);
  window.lingolensTheme = applyTheme;
})();
