// Language detection must stay fast on big notes: highlightAuto only sees a short prefix, and the rest of the
// note is highlighted once with the language that was found.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DETECT_SAMPLE, detectHighlight, startsLikeSql } from '../../public/js/util.js';

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

test('detect: notes that start like an SQL statement are SQL, also where VB.NET scores higher', () => {
  const sql = [
    // VB.NET's LINQ query syntax (Select, From, Where, Join, Group By, Order By) outscores SQL on these two.
    "SELECT c.name, SUM(o.total) AS revenue\nFROM customers c JOIN orders o ON o.customer_id = c.id\nWHERE o.placed_at >= '2026-07-01'\nGROUP BY c.name ORDER BY revenue DESC LIMIT 3;",
    'SELECT c.name,\n       COUNT(o.id)  AS orders,\n       SUM(o.total) AS revenue\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.name\nORDER BY revenue DESC LIMIT 3;',
    'select id, email\nfrom users\nwhere deleted_at is null\norder by created_at desc;',
    '-- active users\n  SELECT id FROM users WHERE active;',
    "WITH recent AS (\n  SELECT * FROM orders WHERE placed_at > now() - interval '7 days'\n)\nSELECT count(*) FROM recent;",
    "INSERT INTO users (email, name)\nVALUES ('a@b.c', 'Ada');",
    "UPDATE orders\nSET status = 'paid'\nWHERE id = 42;",
    'DELETE FROM sessions\nWHERE expires_at < now();',
    'CREATE TABLE notes (\n  id integer PRIMARY KEY,\n  body text NOT NULL\n);',
    'create or replace view active as\nselect * from users where active;',
    'ALTER TABLE users ADD COLUMN last_seen timestamptz;',
    'DROP TABLE IF EXISTS tmp_import;',
  ];
  for (const text of sql) assert.equal(detectHighlight(hljs, text)?.language, 'sql', text.split('\n')[0]);
});

test('detect: code that only looks a little like SQL keeps its own language', () => {
  // The SQL rule leaves these alone (VB's Select Case, Python's with ... as, a call named select). highlight.js's own
  // detection still decides them; it already calls this VB snippet SQL, which this rule doesn't change.
  const vb = 'Select Case answer\n  Case 1\n    Console.WriteLine("one")\n  Case Else\n    Console.WriteLine("other")\nEnd Select';
  for (const t of [vb, "with open('x') as fh:", 'select(el).on(fn)', 'selection = 1', 'update(state)', 'Dim x As Integer']) {
    assert.equal(startsLikeSql(t), false, t);
  }
  const py = "with open('notes.txt') as fh:\n    for line in fh:\n        print(line.strip())";
  assert.notEqual(detectHighlight(hljs, py)?.language, 'sql');
  const js = "select(document.body).on('click', (e) => {\n  console.log(e.target);\n});";
  assert.notEqual(detectHighlight(hljs, js)?.language, 'sql');
  // Plain sentences that start with an SQL word stay plain text (as before the SQL rule), or keep their old guess.
  for (const t of ['Select all and paste it here', 'Delete from the list what you do not need', 'Drop table tennis practice today?']) {
    assert.notEqual(detectHighlight(hljs, t)?.language, 'sql', t);
  }
  const vbModule = 'Module Program\n  Sub Main()\n    Dim q = From c In customers Where c.Active Select c.Name\n    Console.WriteLine(q.Count())\n  End Sub\nEnd Module';
  assert.equal(detectHighlight(hljs, vbModule)?.language, 'vbnet');
});
