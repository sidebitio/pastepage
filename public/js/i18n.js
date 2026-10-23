// Translations: locale choice, JSON loading with English fallback, t() with plurals, DOM application.

/** Supported UI languages; English is the fallback. */
export const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'ja'];

const PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];
/** url -> Promise of the parsed messages; a failed load is dropped so it can be tried again. */
const cache = {};
/** The locale in use, its messages and the English fallback; replaced together, only after a load succeeded. */
let current = 'en';
let messages = {};
let english = {};
/** Bumped by every loadLocale call, so a call that was overtaken by a newer one changes nothing. */
let loadSeq = 0;
const pluralRules = {};

/**
 * Choose the UI language.
 * @param {string|null} saved saved preference, used if supported
 * @param {string[]} navLangs navigator.languages
 * @returns {string} a member of LOCALES
 */
export function pickLocale(saved, navLangs) {
  if (LOCALES.includes(saved)) return saved;
  for (const l of navLangs || []) {
    const p = String(l).split('-')[0].toLowerCase();
    if (LOCALES.includes(p)) return p;
  }
  return 'en';
}

function fetchMessages(fetchFn, url) {
  cache[url] ??= (async () => {
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    return r.json();
  })().catch((err) => { delete cache[url]; throw err; });
  return cache[url];
}

/**
 * Load a locale (and English as the fallback) and make it current once both are loaded.
 * Until then the previous locale stays current. When calls overlap, the last one requested wins: an earlier call
 * that finishes later changes nothing. If the locale can't be loaded (or isn't in LOCALES), the previous locale
 * stays (English on a cold start) and nothing is thrown; only a failure to load English throws, from the latest call.
 * @param {string} locale one of LOCALES
 * @param {{fetchFn?: Function, base?: string}} [opts] fetch override and URL prefix
 * @returns {Promise<void>}
 */
export async function loadLocale(locale, { fetchFn = globalThis.fetch, base = 'i18n/' } = {}) {
  if (!LOCALES.includes(locale)) return;
  const seq = ++loadSeq;
  const en = fetchMessages(fetchFn, base + 'en.json');
  const [enRes, locRes] = await Promise.allSettled([en, locale === 'en' ? en : fetchMessages(fetchFn, base + locale + '.json')]);
  if (seq !== loadSeq) return;
  if (enRes.status === 'rejected') throw enRes.reason;
  english = enRes.value;
  if (locRes.status === 'rejected') {
    if (current === 'en') messages = english; // nothing loaded yet: show English, not raw keys
    return;
  }
  messages = locRes.value;
  current = locale;
}

/**
 * The locale currently in use.
 * @returns {string}
 */
export const currentLocale = () => current;

const lookup = (msgs, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), msgs);
const isPlural = (v) => v && typeof v === 'object' && Object.keys(v).length > 0 && Object.keys(v).every((k) => PLURAL_KEYS.includes(k));
const pluralForm = (locale, n) => (pluralRules[locale] ??= new Intl.PluralRules(locale)).select(n);

/**
 * Translate a dot-path key, filling {name} placeholders and choosing plural forms by vars.count.
 * Lookup order: current locale, English, the key itself. A plural form is chosen with the rules of the language
 * the text comes from. Placeholders without an own property in vars stay as written.
 * @param {string} key e.g. 'invite.text'
 * @param {object|null} [vars] placeholder values; a numeric count selects the plural form
 * @returns {string}
 */
export function t(key, vars) {
  const vs = vars && typeof vars === 'object' ? vars : {};
  let lang = current;
  let v = lookup(messages, key);
  if (v === undefined) { v = lookup(english, key); lang = 'en'; }
  if (v === undefined) return key;
  if (isPlural(v)) {
    const form = typeof vs.count === 'number' ? pluralForm(lang, vs.count) : 'other';
    v = v[form] ?? v.other;
    if (v === undefined) return key;
  }
  if (typeof v !== 'string') return key;
  return v.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(vs, name) ? String(vs[name]) : m));
}

/**
 * Format a Unix timestamp in the current locale with Intl: a two-digit hour and minute for today, otherwise a
 * short date followed by that time. Locale-dependent, e.g. "14:05" (nl, de, fr, es, ja) or "02:05 PM" (en)
 * for today, and "23 okt 14:05" or "Oct 23 02:05 PM" for another day.
 * @param {number} tsSeconds Unix seconds
 * @returns {string}
 */
export function formatTime(tsSeconds) {
  const d = new Date(tsSeconds * 1000);
  const hm = new Intl.DateTimeFormat(current, { hour: '2-digit', minute: '2-digit' }).format(d);
  if (d.toDateString() === new Date().toDateString()) return hm;
  return new Intl.DateTimeFormat(current, { day: 'numeric', month: 'short' }).format(d) + ' ' + hm;
}

/**
 * Apply translations to elements under root via data-i18n (text), data-i18n-placeholder,
 * data-i18n-title and data-i18n-aria (aria-label) attributes.
 * @param {ParentNode} [root] defaults to document
 * @returns {void}
 */
export function applyDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.setAttribute('title', t(el.dataset.i18nTitle));
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
