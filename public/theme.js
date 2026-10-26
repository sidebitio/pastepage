// Applies the saved colour theme and width (wide or normal) before the first paint (a classic script in <head>, so no flash of the wrong theme).
// "light" and "dark" set <html data-theme>; anything else (or nothing) follows the system setting.
(function () {
  'use strict';
  var theme = null;
  try { theme = window.localStorage.getItem('pastepage-theme'); } catch (e) { /* storage blocked */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
  var width = null;
  try { width = window.localStorage.getItem('pastepage-width'); } catch (e) { /* storage blocked */ }
  if (width === 'wide') document.documentElement.classList.add('wide');
})();
