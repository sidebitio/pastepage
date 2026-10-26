// Tests for the expiry text in public/js/menus.js: the toast after changing the expiry names the real result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeExpiry, parseWidth, WIDTHS, parseFold, FOLDS } from '../../public/js/menus.js';

const en = JSON.parse(readFileSync(new URL('../../public/i18n/en.json', import.meta.url), 'utf8'));
/** A small English translator: looks up the key and fills in {placeholders}. */
const t = (key, vars = {}) => key.split('.').reduce((o, k) => o?.[k], en).replace(/\{(\w+)\}/g, (_, n) => String(vars[n]));

test('expiry: a choice the server granted is named as in the menu', () => {
  assert.equal(describeExpiry(1 * 3600, t), '1 hour');
  assert.equal(describeExpiry(24 * 3600 - 0.4, t), '24 hours'); // a moment has passed since the server set it
  assert.equal(describeExpiry(72 * 3600 - 3, t), '3 days');
  assert.equal(describeExpiry(168 * 3600 + 2, t), '7 days'); // clocks a little apart
});

test('expiry: a choice capped by the server shows the time actually left', () => {
  assert.equal(describeExpiry(48 * 3600 - 0.4, t), '2d'); // MAX_HOURS=48, 3 days chosen
  assert.equal(describeExpiry(10 * 3600 - 0.4, t), '10h 0m'); // MAX_HOURS=10, 24 hours chosen
  assert.equal(describeExpiry(5 * 3600, t), '5h 0m');
});

test('width: only "wide" is wide; missing or invalid stored values mean normal', () => {
  assert.equal(parseWidth('wide'), 'wide');
  assert.equal(parseWidth('normal'), 'normal');
  for (const v of [null, undefined, '', 'Wide', 'WIDE', ' wide', 'full', 'system', 1, {}]) assert.equal(parseWidth(v), 'normal');
  assert.deepEqual(WIDTHS, ['normal', 'wide']);
});

test('long notes: only "full" shows in full; missing or invalid stored values mean fold', () => {
  assert.equal(parseFold('full'), 'full');
  assert.equal(parseFold('fold'), 'fold');
  for (const v of [null, undefined, '', 'Full', 'FULL', ' full', 'wide', 'none', 1, {}]) assert.equal(parseFold(v), 'fold');
  assert.deepEqual(FOLDS, ['fold', 'full']);
});
