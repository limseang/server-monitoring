// Apply the saved theme before first paint (no flash).
(function () {
  var t = null;
  try {
    t = localStorage.getItem('sb-theme');
  } catch (e) {}
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
