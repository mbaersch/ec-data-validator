// Pre-hydration: pick the best-guess theme before the first paint so
// a stored "dark" preference (or a dark OS theme) does not flash light.
// popup.js will reconcile against chrome.storage as soon as it runs.
(function () {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) { /* noop */ }
})();
