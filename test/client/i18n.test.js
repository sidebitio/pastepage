// Tests for public/js/i18n.js: locale choice, loading, lookup, plurals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, pickLocale, loadLocale, t, currentLocale } from '../../public/js/i18n.js';

const respond = (files, url) => (url in files
  ? { ok: true, status: 200, json: async () => files[url] }
  : { ok: false, status: 404, json: async () => ({}) });

const fakeFetch = (files, calls = []) => async (url) => {
  calls.push(url);
  return respond(files, url);
};

/** A promise with its resolve function, to control when a fake fetch answers. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((r) => setImmediate(r));

// Every test uses this English fixture (loaded files are cached by URL).
const EN = {
  hi: 'Hi {name}',
  a: { b: 'deep' },
  n: { one: '{count} line', other: '{count} lines' },
  m: { one: '{count} note', other: '{count} notes' },
  c: 'a {constructor} b {toString} c {__proto__}',
};

test('i18n: LOCALES', () => {
  assert.deepEqual(LOCALES, ['en', 'nl', 'de', 'fr', 'es', 'ja']);
});

test('i18n: pickLocale', () => {
  assert.equal(pickLocale(null, ['nl-NL', 'en']), 'nl');
  assert.equal(pickLocale('ja', ['nl']), 'ja');
  assert.equal(pickLocale(null, ['pt-BR']), 'en');
  assert.equal(pickLocale('xx', ['de-AT']), 'de');
});

test('i18n: loadLocale fetches through fetchFn and t fills vars', async () => {
  const calls = [];
  await loadLocale('nl', { fetchFn: fakeFetch({ 'i18n/en.json': EN, 'i18n/nl.json': { hi: 'Hoi {name}' } }, calls) });
  assert.ok(calls.includes('i18n/nl.json'));
  assert.equal(currentLocale(), 'nl');
  assert.equal(t('hi', { name: 'Ada' }), 'Hoi Ada');
  assert.equal(t('hi', {}), 'Hoi {name}');
  assert.equal(t('a.b'), 'deep');       // English fallback
  assert.equal(t('nope.key'), 'nope.key'); // key itself
});

test('i18n: a failed fetch keeps the previous locale', async () => {
  assert.equal(currentLocale(), 'nl');
  await loadLocale('de', { fetchFn: fakeFetch({ 'i18n/en.json': EN }) });
  assert.equal(currentLocale(), 'nl');
  assert.equal(t('hi', { name: 'Ada' }), 'Hoi Ada');
});

test('i18n: the last requested locale wins, even when an earlier request finishes later', async () => {
  await loadLocale('en', { fetchFn: fakeFetch({ 'i18n/en.json': EN }) });
  const slow = deferred();
  const files = { 'race/en.json': EN, 'race/de.json': { hi: 'Hallo {name}' }, 'race/nl.json': { hi: 'Hoi {name}' } };
  const fetchFn = async (url) => (url === 'race/de.json' ? slow.promise : respond(files, url));
  const de = loadLocale('de', { fetchFn, base: 'race/' }); // slow
  const nl = loadLocale('nl', { fetchFn, base: 'race/' }); // fast
  await nl;
  assert.equal(currentLocale(), 'nl');
  slow.resolve(respond(files, 'race/de.json'));
  await de;
  assert.equal(currentLocale(), 'nl');
  assert.equal(t('hi', { name: 'Ada' }), 'Hoi Ada');
});

test('i18n: while a locale loads, the previous one stays current', async () => {
  await loadLocale('nl', { fetchFn: fakeFetch({ 'i18n/en.json': EN, 'i18n/nl.json': { hi: 'Hoi {name}' } }) });
  assert.equal(currentLocale(), 'nl');
  const slow = deferred();
  const files = { 'wait/en.json': EN, 'wait/de.json': { hi: 'Hallo {name}' } };
  const fetchFn = async (url) => (url === 'wait/de.json' ? slow.promise : respond(files, url));
  const loading = loadLocale('de', { fetchFn, base: 'wait/' });
  await settle();
  assert.equal(currentLocale(), 'nl');
  assert.equal(t('hi', { name: 'Ada' }), 'Hoi Ada');
  slow.resolve(respond(files, 'wait/de.json'));
  await loading;
  assert.equal(currentLocale(), 'de');
  assert.equal(t('hi', { name: 'Ada' }), 'Hallo Ada');
});

test('i18n: an unsupported locale is ignored without fetching', async () => {
  const calls = [];
  const before = currentLocale();
  assert.notEqual(before, 'en');
  await loadLocale('xx', { fetchFn: fakeFetch({ 'i18n/en.json': EN }, calls) });
  assert.equal(currentLocale(), before);
  assert.ok(!calls.some((u) => u.includes('xx')), calls.join());
});

test('i18n: plurals', async () => {
  await loadLocale('en', { fetchFn: fakeFetch({ 'i18n/en.json': EN }) });
  assert.equal(t('n', { count: 1 }), '1 line');
  assert.equal(t('n', { count: 2 }), '2 lines');
  await loadLocale('ja', { fetchFn: fakeFetch({ 'i18n/en.json': EN, 'i18n/ja.json': { n: { other: '{count} 行' } } }) });
  assert.equal(t('n', { count: 1 }), '1 行');
  await loadLocale('fr', { fetchFn: fakeFetch({ 'i18n/en.json': EN, 'i18n/fr.json': { n: { one: '{count} ligne', other: '{count} lignes' } } }) });
  assert.equal(t('n', { count: 1000000 }), '1000000 lignes');
});

test('i18n: a key missing in the current locale uses English text with English plural rules', async () => {
  await loadLocale('ja', { fetchFn: fakeFetch({ 'i18n/en.json': EN, 'i18n/ja.json': { n: { other: '{count} 行' } } }) });
  assert.equal(currentLocale(), 'ja');
  assert.equal(t('m', { count: 1 }), '1 note'); // Japanese rules would pick "other": "1 notes"
  assert.equal(t('m', { count: 3 }), '3 notes');
  assert.equal(t('n', { count: 1 }), '1 行'); // found in Japanese: Japanese rules
});

test('i18n: placeholders only use the caller\'s own values, and null vars are allowed', async () => {
  await loadLocale('en', { fetchFn: fakeFetch({ 'i18n/en.json': EN }) });
  assert.equal(t('c', {}), 'a {constructor} b {toString} c {__proto__}');
  assert.equal(t('c'), 'a {constructor} b {toString} c {__proto__}');
  assert.equal(t('c', { constructor: 'X', toString: 'Y' }), 'a X b Y c {__proto__}');
  assert.equal(t('hi', null), 'Hi {name}');
  assert.equal(t('n', null), '{count} lines');
});

test('i18n: only the latest call reports a failure to load English', async () => {
  const slow = deferred();
  const files = { 'ok/en.json': EN, 'ok/nl.json': { hi: 'Hoi {name}' } };
  const stale = loadLocale('de', { fetchFn: async () => slow.promise, base: 'broken/' });
  await loadLocale('nl', { fetchFn: fakeFetch(files), base: 'ok/' });
  slow.resolve({ ok: false, status: 500, json: async () => ({}) });
  await stale; // overtaken: no error, no change
  assert.equal(currentLocale(), 'nl');
  await assert.rejects(loadLocale('de', { fetchFn: fakeFetch({}), base: 'gone/' }), /gone\/en\.json: HTTP 404/);
  assert.equal(currentLocale(), 'nl');
});

test('i18n: loadLocale with an unsupported locale does not cancel a valid load in flight', async () => {
  const mod = await import('../../public/js/i18n.js?invalid-cancel');
  const gate = deferred();
  const fetchFn = async (url) => {
    if (url === 'i18n/nl.json') await gate.promise;
    return respond({ 'i18n/en.json': EN, 'i18n/nl.json': { hi: 'Hoi {name}' } }, url);
  };
  const pending = mod.loadLocale('nl', { fetchFn });
  await settle();
  await mod.loadLocale('xx', { fetchFn });
  gate.resolve();
  await pending;
  assert.equal(mod.currentLocale(), 'nl');
  assert.equal(mod.t('hi', { name: 'Ada' }), 'Hoi Ada');
});

test('i18n: cold start with a failing locale shows English, not raw keys', async () => {
  const mod = await import('../../public/js/i18n.js?cold');
  await mod.loadLocale('nl', { fetchFn: fakeFetch({ 'i18n/en.json': EN }) });
  assert.equal(mod.currentLocale(), 'en');
  assert.equal(mod.t('hi', { name: 'Ada' }), 'Hi Ada');
});
