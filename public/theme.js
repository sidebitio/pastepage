// Applies the saved colour theme before the first paint (a classic script in <head>, so no flash of the wrong theme).
// "light" and "dark" set <html data-theme>; anything else (or nothing) follows the system setting.
(function () {
  'use strict';
  var theme = null;
  try { theme = window.localStorage.getItem('pastepage-theme'); } catch (e) { /* storage blocked */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
})();
