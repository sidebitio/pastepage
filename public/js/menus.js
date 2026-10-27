// Header menus (Join, Invite, expiry, Settings) and the theme and language controls, which appear in the
// Settings menu and in the footer of the "session ended" screen.
import { APP_NAME, storage } from './brand.js';
import { inviteLink, inviteText } from './invite.js';
import { LOCALES, currentLocale } from './i18n.js';

/** Expiry choices in hours: 1h, 8h, 24h, 3d, 7d. */
export const HOURS = [1, 8, 24, 72, 168];
/** Theme choices; "system" follows the operating system setting. */
export const THEMES = ['system', 'light', 'dark'];
/** Width choices: "normal" keeps the column at its usual width, "wide" lets the session view use the full window. */
export const WIDTHS = ['normal', 'wide'];
/** Long-note choices: "fold" cuts notes over 28 lines behind "Show all", "full" always shows them in full. */
export const FOLDS = ['fold', 'full'];
/** UI languages offered in the picker, each by its own name. */
const LANGUAGE_NAMES = { en: 'English', nl: 'Nederlands', de: 'Deutsch', fr: 'Français', es: 'Español', ja: '日本語' };
const MENUS = ['join', 'invite', 'expiry', 'settings'];

const $ = (id) => document.getElementById(id);
let opts = null;
let expires = 0;
let skew = 0;
/** On the draft page (no session yet): the hours chosen for the session the first Send will make; 0 in a session. */
let draftHours = 0;

/**
 * Close every header menu.
 * @returns {void}
 */
export function closeMenus() {
  for (const m of MENUS) {
    $(m + '-menu').hidden = true;
    $(m + '-btn').setAttribute('aria-expanded', 'false');
  }
}

/**
 * Open one header menu (closing the others). The Invite menu is filled in first.
 * @param {'join'|'invite'|'expiry'|'settings'} name
 * @returns {void}
 */
export function openMenu(name) {
  closeMenus();
  if (name === 'invite') fillInvite();
  $(name + '-menu').hidden = false;
  $(name + '-btn').setAttribute('aria-expanded', 'true');
}

function toggleMenu(name) {
  if ($(name + '-menu').hidden) openMenu(name); else closeMenus();
}

/** The values behind each copy button in the Invite menu. */
function inviteValues() {
  const { id, pass, base } = opts.getInvite();
  return {
    linkPass: pass ? inviteLink(base, id, pass) : '',
    link: inviteLink(base, id),
    id,
    pass,
    invite: pass ? inviteText((k, v) => opts.t(k, { app: APP_NAME, ...v }), { base, id, pass }) : '',
  };
}

function fillInvite() {
  const v = inviteValues();
  // textContent only: the password may come from a URL and is untrusted text.
  $('inv-linkPass').textContent = v.linkPass;
  $('inv-link').textContent = v.link;
  $('inv-id').textContent = v.id;
  $('inv-pass').textContent = v.pass || opts.t('invite.noPass');
  $('inv-row-linkPass').hidden = !v.pass;
  $('inv-copy-pass').hidden = !v.pass;
  $('inv-copy-invite').hidden = !v.pass;
}

async function onInviteClick(e) {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const kind = btn.dataset.copy;
  const value = inviteValues()[kind];
  if (!value) return;
  const shown = { linkPass: 'inv-linkPass', link: 'inv-link', id: 'inv-id', pass: 'inv-pass' }[kind];
  if (await opts.copy(value, shown ? $(shown) : null)) opts.toast(opts.t('invite.copied.' + kind));
}

/** A time left as the expiry pill shows it: days from 48 hours on, else hours and minutes, else minutes. */
function formatLeft(left, t) {
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return h >= 48 ? t('time.d', { d: Math.round(h / 24) })
    : h >= 1 ? t('time.hm', { h, m })
      : t('time.m', { m: Math.max(1, m) });
}

/**
 * Say how long until a session is deleted, for the message after its expiry was changed. When the time left is one
 * of the expiry choices (to the minute), that choice's name; otherwise, for example when the server capped the
 * choice at its MAX_HOURS, the time left as the pill shows it.
 * @param {number} left seconds until the session is deleted
 * @param {(key: string, vars?: object) => string} t translate function
 * @returns {string} e.g. "24 hours", "2d" or "10h 0m"
 */
export function describeExpiry(left, t) {
  const choice = HOURS.find((h) => Math.abs(h * 3600 - left) < 60);
  return choice ? t('hours.' + choice) : formatLeft(Math.round(left / 60) * 60, t);
}

/**
 * Seconds until the session is deleted, by the expiry last set, corrected for the difference between server and
 * browser clocks.
 * @returns {number} 0 when the expiry is unknown or has passed
 */
export function secondsLeft() {
  return expires ? Math.max(0, expires - (Date.now() / 1000 + skew)) : 0;
}

/** Show the time left on the expiry pill, corrected for the difference between server and browser clocks. */
function updateExpiry() {
  const { t } = opts;
  const btn = $('expiry-btn');
  btn.dataset.i18nTitle = draftHours ? 'expiry.afterTitle' : 'expiry.title'; // so applyDom keeps the right tooltip
  btn.title = t(btn.dataset.i18nTitle);
  if (draftHours) {
    btn.textContent = t('expiry.after', { time: t('hours.' + draftHours) });
    btn.classList.remove('soon');
    return;
  }
  if (!expires) {
    btn.textContent = t('expiry.button');
    btn.classList.remove('soon');
    return;
  }
  const left = secondsLeft();
  btn.textContent = t('expiry.in', { time: formatLeft(left, t) });
  btn.classList.toggle('soon', left < 3600);
}

/**
 * Set the session's expiry shown on the pill.
 * @param {number} exp expiry in Unix seconds, or 0 for unknown
 * @param {number} [serverNow] the server's current time in Unix seconds, to correct clock skew
 * @returns {void}
 */
export function setExpiry(exp, serverNow) {
  expires = Number.isFinite(exp) ? exp : 0;
  if (Number.isFinite(serverNow)) skew = serverNow - Date.now() / 1000;
  updateExpiry();
}

/**
 * Show the draft page's expiry choice on the pill ("Deletes after 24 hours") and hide Clear and End, which need a
 * session; 0 goes back to showing the session's own expiry.
 * @param {number} hours one of HOURS, or 0
 * @returns {void}
 */
export function setDraftHours(hours) {
  draftHours = HOURS.includes(hours) ? hours : 0;
  $('expiry-danger').hidden = draftHours !== 0;
  updateExpiry();
}

/**
 * The saved theme choice.
 * @returns {'system'|'light'|'dark'}
 */
export function currentTheme() {
  const v = storage.get('localStorage', 'theme');
  return v === 'light' || v === 'dark' ? v : 'system';
}

/**
 * Apply and save a theme: light and dark set <html data-theme>, system removes it.
 * theme.js applies the saved choice on the next page load, before the first paint.
 * @param {'system'|'light'|'dark'} choice
 * @returns {void}
 */
export function applyTheme(choice) {
  const theme = THEMES.includes(choice) ? choice : 'system';
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  storage.set('localStorage', 'theme', theme);
  markTheme();
}

function markTheme() {
  const theme = currentTheme();
  for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === theme));
}

/**
 * Read a stored width choice.
 * @param {unknown} v the stored value
 * @returns {'normal'|'wide'} "wide" only for exactly "wide"; anything else is "normal"
 */
export function parseWidth(v) {
  return v === 'wide' ? 'wide' : 'normal';
}

/**
 * The saved width choice.
 * @returns {'normal'|'wide'}
 */
export function currentWidth() {
  return parseWidth(storage.get('localStorage', 'width'));
}

/**
 * Apply and save a width: wide adds the class "wide" to <html>, normal removes it.
 * theme.js applies the saved choice on the next page load, before the first paint.
 * @param {'normal'|'wide'} choice
 * @returns {void}
 */
export function applyWidth(choice) {
  const width = parseWidth(choice);
  document.documentElement.classList.toggle('wide', width === 'wide');
  storage.set('localStorage', 'width', width);
  markWidth();
}

function markWidth() {
  const width = currentWidth();
  for (const b of document.querySelectorAll('[data-width-choice]')) b.setAttribute('aria-pressed', String(b.dataset.widthChoice === width));
}

/**
 * Read a stored long-notes choice.
 * @param {unknown} v the stored value
 * @returns {'fold'|'full'} "full" only for exactly "full"; anything else is "fold"
 */
export function parseFold(v) {
  return v === 'full' ? 'full' : 'fold';
}

/**
 * The saved long-notes choice.
 * @returns {'fold'|'full'}
 */
export function currentFold() {
  return parseFold(storage.get('localStorage', 'fold'));
}

/**
 * Apply and save a long-notes choice: "full" adds the class "full-notes" to <html>, which the stylesheet uses to lift the
 * height limit and hide the Show all button of every note at once; "fold" removes it, so notes fold again as before.
 * theme.js applies the saved choice on the next page load, before the first paint.
 * @param {'fold'|'full'} choice
 * @returns {void}
 */
export function applyFold(choice) {
  const fold = parseFold(choice);
  document.documentElement.classList.toggle('full-notes', fold === 'full');
  storage.set('localStorage', 'fold', fold);
  markFold();
}

function markFold() {
  const fold = currentFold();
  for (const b of document.querySelectorAll('[data-fold-choice]')) b.setAttribute('aria-pressed', String(b.dataset.foldChoice === fold));
}

/** Show the language in use in every language picker (settings menu, start and "session ended" footers). */
function markLanguage() {
  for (const sel of document.querySelectorAll('.lang-select')) sel.value = currentLocale();
}

function initLanguages() {
  for (const sel of document.querySelectorAll('.lang-select')) {
    sel.textContent = '';
    for (const code of LOCALES) {
      const o = document.createElement('option');
      o.value = code;
      o.lang = code;
      o.textContent = LANGUAGE_NAMES[code] ?? code;
      sel.append(o);
    }
    sel.addEventListener('change', () => opts.onLocale(sel.value));
  }
  markLanguage();
}

/**
 * Write the menus' own texts again after a change of UI language: the expiry pill, the language pickers and the
 * Invite menu if it is open. Elements with data-i18n attributes are left to applyDom.
 * @returns {void}
 */
export function relabelMenus() {
  if (!opts) return;
  updateExpiry();
  markLanguage();
  if (!$('invite-menu').hidden) fillInvite();
}

/**
 * Wire up the menus and the theme and language controls once at startup.
 * @param {object} o
 * @param {(key: string, vars?: object) => string} o.t translate function
 * @param {(text: string, selectEl?: Element|null) => Promise<boolean>} o.copy copy to the clipboard
 * @param {(msg: string) => void} o.toast show a short message
 * @param {() => {id: string, pass: string, base: string}} o.getInvite the current session's invite parts
 * @param {() => boolean} o.beforeInvite the Invite button was clicked; false when the app takes care of it (on the
 *   draft page, it first makes the session)
 * @param {(hours: number) => void} o.onExpire an expiry choice was clicked
 * @param {() => void} o.onClear "Clear all notes" was clicked
 * @param {() => void} o.onEnd "End session" was clicked
 * @param {(locale: string) => void} o.onLocale a UI language was chosen in a language picker
 * @returns {void}
 */
export function initMenus(o) {
  opts = o;
  for (const m of MENUS) {
    $(m + '-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (m === 'invite' && $('invite-menu').hidden && opts.beforeInvite?.() === false) { closeMenus(); return; }
      toggleMenu(m);
    });
  }
  document.addEventListener('click', (e) => {
    if (!MENUS.some((m) => $(m + '-menu').contains(e.target))) closeMenus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  $('invite-menu').addEventListener('click', onInviteClick);

  for (const h of HOURS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i18n = 'hoursShort.' + h;
    b.textContent = o.t('hoursShort.' + h);
    b.addEventListener('click', () => { closeMenus(); opts.onExpire(h); });
    $('expiry-opts').append(b);
  }
  $('clear-btn').addEventListener('click', () => { closeMenus(); opts.onClear(); });
  $('end-btn').addEventListener('click', () => { closeMenus(); opts.onEnd(); });
  setInterval(updateExpiry, 20000);
  updateExpiry();

  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.addEventListener('click', () => applyTheme(b.dataset.themeChoice));
  }
  markTheme();
  for (const b of document.querySelectorAll('[data-width-choice]')) {
    b.addEventListener('click', () => applyWidth(b.dataset.widthChoice));
  }
  markWidth();
  for (const b of document.querySelectorAll('[data-fold-choice]')) {
    b.addEventListener('click', () => applyFold(b.dataset.foldChoice));
  }
  markFold();
  initLanguages();
}
