// Language detection must stay fast on big notes: highlightAuto only sees a short prefix, and the rest of the
// note is highlighted once with the language that was found.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DETECT_SAMPLE, detectHighlight } from '../../public/js/util.js';

const src = readFileSync(new URL('../../public/vendor/highlight.min.js', import.meta.url), 'utf8');
const sandbox = vm.createContext({ console });
vm.runInContext(src, sandbox);
const hljs = sandbox.hljs;

const LOG = 'Oct 22 13:37:01 web-01 nginx[1234]: 10.0.0.5 - - "GET /api/items?id=42 HTTP/1.1" 200 512 "-" "curl/8.4"\n';
const SQL = "SELECT u.id, u.name, COUNT(o.id) AS orders FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.created_at > '2026-01-01' GROUP BY u.id, u.name;\n";
const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

test('detect: a 190k-character log is detected in under 2000 ms (a generous bound for slow CI runners)', () => {
  const text = fill(LOG, 190000);
  const t0 = performance.now();
  const r = detectHighlight(hljs, text);
  const ms = performance.now() - t0;
  console.log(`detect 190k log: ${ms.toFixed(0)} ms -> ${r ? r.language : null}`);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

test('detect: long notes are highlighted in full with the language found in the prefix', () => {
  const text = fill(SQL, 190000);
  const t0 = performance.now();
  const r = detectHighlight(hljs, text);
  const ms = performance.now() - t0;
  console.log(`detect 190k sql: ${ms.toFixed(0)} ms -> ${r ? r.language : null}`);
  assert.ok(r, 'sql should be detected');
  assert.equal(r.language, 'sql');
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  // The full text is in the output (tags stripped and entities decoded give the original text back).
  const plain = r.value.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  assert.equal(plain, text);
});

test('detect: a short note is detected from the whole text', () => {
  const text = fill(SQL, 500);
  assert.ok(text.length < DETECT_SAMPLE);
  assert.equal(detectHighlight(hljs, text)?.language, 'sql');
});

test('detect: text with no recognisable language returns null', () => {
  assert.equal(detectHighlight(hljs, 'hello'), null);
});
