// Every UI language in LOCALES has a translation file with exactly English's keys and placeholders, valid plural
// forms, no empty text and no product name (the invite text gets it through {app}).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCALES } from '../../public/js/i18n.js';
import { APP_NAME } from '../../public/js/brand.js';

const PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const I18N = new URL('../../public/i18n/', import.meta.url);
const raw = (locale) => readFileSync(new URL(locale + '.json', I18N), 'utf8');
const load = (locale) => JSON.parse(raw(locale));

/** A plural object: all its keys are plural categories. It counts as one leaf. */
const isPlural = (v) => v !== null && typeof v === 'object' && Object.keys(v).length > 0
  && Object.keys(v).every((k) => PLURAL_KEYS.includes(k));

/** Flatten to Map(dot-path -> string | plural object). */
function leaves(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix + k;
    if (typeof v === 'string' || isPlural(v)) out.set(key, v);
    else if (v !== null && typeof v === 'object') leaves(v, key + '.', out);
    else out.set(key, v); // numbers, null, arrays…: reported as wrong below
  }
  return out;
}

/** The {placeholders} of a leaf; for a plural object, of all its forms together. */
const placeholders = (v) => {
  const texts = typeof v === 'string' ? [v] : Object.values(v);
  return [...new Set(texts.flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();
};

const EN = leaves(load('en'));

test('locales: English has the expected size', () => {
  assert.ok(EN.size >= 150, `en.json has ${EN.size} leaf keys`);
});

for (const locale of LOCALES) {
  test(`locales: ${locale}.json parses`, () => {
    assert.doesNotThrow(() => load(locale));
  });

  test(`locales: ${locale}.json has exactly English's keys`, () => {
    const keys = [...leaves(load(locale)).keys()];
    const extra = keys.filter((k) => !EN.has(k));
    const lacking = [...EN.keys()].filter((k) => !keys.includes(k));
    assert.deepEqual({ extra, lacking }, { extra: [], lacking: [] });
  });

  test(`locales: ${locale}.json leaves have English's kind and placeholders`, () => {
    const msgs = leaves(load(locale));
    const wrong = [];
    for (const [key, enValue] of EN) {
      const v = msgs.get(key);
      if (v === undefined) continue; // reported by the key test
      if (isPlural(enValue) !== isPlural(v) || (!isPlural(v) && typeof v !== 'string')) {
        wrong.push(`${key}: ${isPlural(enValue) ? 'plural' : 'string'} expected`);
        continue;
      }
      const want = placeholders(enValue).join(',');
      const got = placeholders(v).join(',');
      if (want !== got) wrong.push(`${key}: {${got}} instead of {${want}}`);
    }
    assert.deepEqual(wrong, []);
  });

  test(`locales: ${locale}.json plural forms are valid`, () => {
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    const wrong = [];
    for (const [key, v] of leaves(load(locale))) {
      if (!isPlural(v)) continue;
      if (!('other' in v)) wrong.push(`${key}: no "other"`);
      if (locale !== 'ja' && !('one' in v)) wrong.push(`${key}: no "one"`);
      for (const form of Object.keys(v)) {
        if (!categories.includes(form)) wrong.push(`${key}: "${form}" is not a ${locale} plural form`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  test(`locales: ${locale}.json has no empty text`, () => {
    const empty = [];
    for (const [key, v] of leaves(load(locale))) {
      const texts = typeof v === 'string' ? [v] : isPlural(v) ? Object.values(v) : [v];
      if (texts.some((s) => typeof s !== 'string' || s.trim() === '')) empty.push(key);
    }
    assert.deepEqual(empty, []);
  });

  test(`locales: ${locale}.json leaves the product name out`, () => {
    assert.ok(!raw(locale).toLowerCase().includes(APP_NAME.toLowerCase()), `${locale}.json contains ${APP_NAME}`);
  });
}
