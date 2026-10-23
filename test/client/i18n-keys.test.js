// Every translation key the UI uses must exist in public/i18n/en.json: data-i18n* attributes in index.html,
// literal t('…') calls and every other key-shaped string in public/js/*.js (setBusy arguments, both arms of a
// ternary), the key families built at run time ('hours.' + h and the like), and an error message for every code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ERRORS } from '../../src/errors.js';
import { HOURS } from '../../public/js/menus.js';

const PUBLIC = new URL('../../public/', import.meta.url);
const read = (path) => readFileSync(new URL(path, PUBLIC), 'utf8');
const PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];

const en = () => JSON.parse(read('i18n/en.json'));
const jsSources = () => readdirSync(new URL('js/', PUBLIC)).filter((f) => f.endsWith('.js')).map((f) => ({ file: f, src: read('js/' + f) }));

/** True when the dot-path key resolves to a string or a plural object (a leaf the UI can show). */
function isLeaf(msgs, key) {
  const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), msgs);
  if (typeof v === 'string') return v !== '';
  if (!v || typeof v !== 'object') return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => PLURAL_KEYS.includes(k) && typeof v[k] === 'string') && 'other' in v;
}

const missing = (msgs, keys) => [...new Set(keys)].filter((k) => !isLeaf(msgs, k));

/** Error codes the browser can show as t('error.<CODE>'): the server's, plus the ones the page makes up itself. */
const ERROR_CODES = [...Object.keys(ERRORS), 'BUSY', 'CONNECTION', 'COPY_BLOCKED', 'DECRYPT', 'INSECURE'];
/** The modules that pass error codes around (net.js makes them, app.js shows them), and their other upper-case literals. */
const CODE_FILES = ['app.js', 'net.js'];
const NOT_ERROR_CODES = ['POST'];

/**
 * Keys built at run time as prefix + value, with every value they can take. Each prefix that public/js
 * concatenates must be listed here, so a new family can't slip past this test.
 */
const families = () => ({
  'error.': ERROR_CODES, // errText(code) / errKey(code) in app.js
  'hours.': HOURS.map(String), // start screen options, expiry toast
  'hoursShort.': HOURS.map(String), // expiry menu buttons
  'invite.copied.': [...read('index.html').matchAll(/\bdata-copy="([^"]+)"/g)].map((m) => m[1]), // Invite copy buttons
});

test('i18n keys: every data-i18n* value in index.html is in en.json', () => {
  const html = read('index.html');
  const keys = [...html.matchAll(/\bdata-i18n(?:-placeholder|-title|-aria)?="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 20, `expected many data-i18n attributes, found ${keys.length}`);
  assert.deepEqual(missing(en(), keys), []);
});

test('i18n keys: every literal t(\'…\') key in public/js is in en.json', () => {
  const keys = [];
  for (const { src } of jsSources()) {
    for (const m of src.matchAll(/\bt\(\s*(['"])([^'"]+)\1\s*[,)]/g)) keys.push(m[2]);
  }
  assert.ok(keys.length > 20, `expected many t() calls, found ${keys.length}`);
  assert.deepEqual(missing(en(), keys), []);
});

test('i18n keys: every key-shaped string literal in public/js is in en.json', () => {
  // Catches keys that reach t() indirectly: setBusy(id, busy, 'join.go', 'join.busy'), t(on ? 'a.b' : 'a.c'),
  // fail('burn.gone'), and so on. A literal counts when its first segment is one of the fixed namespaces below
  // (a fixed list, so a deleted section or a misspelled namespace in en.json is still caught).
  const msgs = en();
  const top = new Set(['start', 'join', 'gone', 'room', 'invite', 'expiry', 'time', 'hours', 'hoursShort', 'confirm',
    'toast', 'note', 'reply', 'react', 'pin', 'burn', 'size', 'compose', 'settings', 'credit', 'error']);
  const found = [];
  for (const { file, src } of jsSources()) {
    for (const m of src.matchAll(/(['"`])([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\1/g)) {
      if (top.has(m[2].split('.')[0])) found.push({ file, key: m[2] });
    }
  }
  assert.ok(found.length > 80, `expected many key-shaped literals, found ${found.length}`);
  for (const k of ['join.busy', 'start.busy', 'note.noWrap', 'room.reconnecting']) {
    assert.ok(found.some((f) => f.key === k), `the scan should see ${k}`);
  }
  const bad = found.filter((f) => !isLeaf(msgs, f.key)).map((f) => `${f.file}: ${f.key}`);
  assert.deepEqual([...new Set(bad)], []);
});

test('i18n keys: every key family built at run time is listed, and all its members are in en.json', () => {
  const fams = families();
  const prefixes = new Set();
  for (const { file, src } of jsSources()) {
    // 'prefix.' + x, "prefix." + x, and `prefix.${x}`
    for (const m of src.matchAll(/(['"`])([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)\1\s*\+/g)) prefixes.add(`${file}: ${m[2]}`);
    for (const m of src.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)\$\{/g)) prefixes.add(`${file}: ${m[1]}`);
  }
  assert.ok(prefixes.size >= 4, `expected the known families, found ${[...prefixes].join(', ')}`);
  const unlisted = [...prefixes].filter((p) => !Object.hasOwn(fams, p.split(': ')[1]));
  assert.deepEqual(unlisted, [], 'add these key families to families() in this test');
  assert.equal(fams['invite.copied.'].length, 5, 'data-copy buttons in index.html');
  const keys = Object.entries(fams).flatMap(([prefix, members]) => members.map((m) => prefix + m));
  assert.deepEqual(missing(en(), keys), []);
});

test('i18n keys: every upper-case string literal in app.js and net.js is a known error code', () => {
  const found = new Set();
  for (const { src } of jsSources().filter((f) => CODE_FILES.includes(f.file))) {
    for (const m of src.matchAll(/(['"])([A-Z][A-Z0-9_]{2,})\1/g)) found.add(m[2]);
  }
  assert.ok(found.has('INSECURE') && found.has('CONNECTION'), [...found].join());
  const unknown = [...found].filter((c) => !ERROR_CODES.includes(c) && !NOT_ERROR_CODES.includes(c));
  assert.deepEqual(unknown, [], 'add new codes to ERROR_CODES (and their message to en.json)');
});

test('i18n keys: an error message exists for every error code', () => {
  assert.deepEqual(missing(en(), ERROR_CODES.map((c) => 'error.' + c)), []);
});
