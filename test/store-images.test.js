// Tests for image notes (held in full until delivered), rolling sessions and the usage gauge in the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionStore, hashAuth } from '../src/store.js';

const IV = 'AAAAAAAAAAAAAAAA';

function setup(overrides = {}) {
  const config = { ...loadConfig({}), maxSessionBytes: 2000, maxEvents: 5, maxPreviewBytes: 100, ...overrides };
  const store = new SessionStore(config, () => 1_700_000_000_000);
  const s = store.create({ id: '11-aa-bb', authHash: hashAuth('a'.repeat(64)) });
  const events = [];
  const usages = [];
  store.on('event', (id, wire, info) => events.push({ wire, info }));
  store.on('usage', (id, info) => usages.push(info));
  return { store, s, events, usages };
}
const note = (ct = 'abc') => ({ kind: 'note', client: 'a', iv: IV, ct });
const image = (client = 'a', ct = 'full-image-ciphertext') => ({ kind: 'image', client, iv: IV, ct, piv: IV, pct: 'preview' });
const wires = (store, s) => store.eventsSince(s, -1).events;

test('share is 43 base64url chars and differs per session', () => {
  const { store, s } = setup();
  const s2 = store.create({ id: '12-aa-bb', authHash: s.authHash });
  assert.match(s.share, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(s.share, s2.share);
  assert.equal(s.rolledSeq, 0);
  assert.ok(s.members instanceof Map);
});

test('an image is held in full until the other member has it', () => {
  const { store, s, events, usages } = setup();
  store.memberUp(s, 'a'); store.memberUp(s, 'b');
  const wire = store.append(s, image('a'));
  assert.deepEqual(wire, { seq: 1, ts: 1_700_000_000, kind: 'image', client: 'a', piv: IV, pct: 'preview', full: true, iv: IV, ct: 'full-image-ciphertext' });
  assert.ok(!('pending' in wire) && !('pending' in events[0].wire));
  const before = s.bytes;
  store.got(s, 'b', 1);
  const w = wires(store, s)[0];
  assert.equal(w.full, false);
  assert.ok(!('iv' in w) && !('ct' in w));
  assert.equal(w.pct, 'preview');
  assert.equal(before - s.bytes, IV.length + 'full-image-ciphertext'.length);
  assert.equal(store.totalBytes, s.bytes);
  assert.equal(usages.length, 1);
  assert.deepEqual(Object.keys(usages[0]).sort(), ['rolled', 'used']);
});

test('an image with no other members is stored without its full', () => {
  const { store, s } = setup();
  store.memberUp(s, 'a');
  const wire = store.append(s, image('a'));
  assert.equal(wire.full, false);
  assert.ok(!('ct' in wire));
  assert.equal(s.bytes, IV.length + 'preview'.length + 64);
  assert.equal(store.totalBytes, s.bytes);
});

test('got from a non-member, for an unknown seq or for a note changes nothing', () => {
  const { store, s, usages } = setup();
  store.memberUp(s, 'a'); store.memberUp(s, 'b');
  store.append(s, image('a'));
  store.append(s, note());
  const before = JSON.stringify(wires(store, s)); const bytes = s.bytes;
  store.got(s, 'zzz', 1); store.got(s, 'b', 99); store.got(s, 'b', 2); store.got(s, 'a', 1);
  assert.equal(JSON.stringify(wires(store, s)), before);
  assert.equal(s.bytes, bytes);
  assert.equal(usages.length, 0);
});

test('a clean departure releases the full, an unclean one keeps it', () => {
  const { store, s, usages } = setup();
  store.memberUp(s, 'a'); store.memberUp(s, 'b');
  store.append(s, image('a'));
  store.memberDown(s, 'b', { clean: false });
  assert.equal(s.members.get('b'), 'away');
  assert.equal(wires(store, s)[0].full, true);
  store.memberDown(s, 'b', { clean: true });
  assert.equal(s.members.has('b'), false);
  assert.equal(wires(store, s)[0].full, false);
  assert.equal(usages.length, 1);
  assert.equal(store.totalBytes, s.bytes);
});

test('dropped clients kept as away are capped per session; the one away longest goes as a clean leave', () => {
  const { store, s, usages } = setup({ maxSocketsPerSession: 2 });
  for (const c of ['a', 'b', 'c', 'd']) store.memberUp(s, c);
  store.append(s, image('a')); // pending: b, c, d
  store.memberDown(s, 'c', { clean: false });
  store.memberDown(s, 'b', { clean: false });
  store.memberUp(s, 'c'); store.memberDown(s, 'c', { clean: false }); // c came back and dropped again: now newest
  assert.deepEqual([...s.members].filter(([, v]) => v === 'away').map(([k]) => k), ['b', 'c']);
  store.memberDown(s, 'd', { clean: false }); // a third away: b, away longest, is let go
  assert.deepEqual([...s.members].filter(([, v]) => v === 'away').map(([k]) => k).sort(), ['c', 'd']);
  assert.equal(s.members.has('b'), false);
  assert.deepEqual([...s.events[0].pending].sort(), ['c', 'd']);
  assert.equal(usages.length, 0);
  store.got(s, 'c', 1);
  for (const c of ['e', 'f']) { store.memberUp(s, c); store.memberDown(s, c, { clean: false }); } // c and d go
  assert.equal(s.members.has('d'), false);
  assert.equal(wires(store, s)[0].full, false); // nobody left waiting: the full is released
  assert.equal(usages.length, 1);
  assert.equal(store.totalBytes, s.bytes);
  assert.equal([...s.members.values()].filter((v) => v === 'away').length, 2);
});

test('a clear that rolled off still gives a snapshot from before it, and the session remembers it', () => {
  const { store, s } = setup();
  for (let i = 0; i < 3; i++) store.append(s, note()); // 1-3: a page saw these, then went away (since = 3)
  store.clear(s); // 4
  for (let i = 0; i < 6; i++) store.append(s, note()); // 5-10: the clear rolls off
  assert.equal(s.rolledSeq, 5);
  assert.equal(s.clearedSeq, 4);
  const { mode, events } = store.eventsSince(s, 3);
  assert.equal(mode, 'snapshot');
  assert.deepEqual(events.map((e) => e.kind), ['note', 'note', 'note', 'note', 'note']);
});

test('rollover drops the oldest events and records rolledSeq', () => {
  const { store, s, events } = setup();
  for (let i = 0; i < 6; i++) store.append(s, note());
  assert.deepEqual(s.events.map((e) => e.seq), [2, 3, 4, 5, 6]);
  assert.equal(s.rolledSeq, 1);
  assert.equal(store.eventsSince(s, 0).mode, 'snapshot');
  assert.equal(store.eventsSince(s, 1).mode, 'delta');
  assert.equal(s.bytes, 5 * (3 + IV.length + 64));
  assert.equal(store.totalBytes, s.bytes);
  assert.deepEqual(events.at(-1).info, { used: 1000, rolled: 1 });
});

test('rollover by bytes drops until the new event fits', () => {
  const { store, s } = setup({ maxEvents: 100 });
  const big = 'x'.repeat(700); // 700 + 16 + 64 = 780
  store.append(s, note(big)); store.append(s, note(big));
  assert.equal(s.events.length, 2);
  store.append(s, note(big));
  assert.deepEqual(s.events.map((e) => e.seq), [2, 3]);
  assert.equal(s.rolledSeq, 1);
  store.append(s, note('x'.repeat(1200))); // 1280: needs both gone
  assert.deepEqual(s.events.map((e) => e.seq), [4]);
  assert.equal(s.rolledSeq, 3);
  assert.equal(store.totalBytes, s.bytes);
});

test('an image nobody else waits for is checked against its stored preview only', () => {
  const { store, s } = setup({ maxEvents: 100 });
  store.memberUp(s, 'a');
  const big = 'x'.repeat(700); // 780 each
  store.append(s, note(big)); store.append(s, note(big));
  store.append(s, { kind: 'image', client: 'a', iv: IV, ct: 'y'.repeat(1000), piv: IV, pct: 'preview' });
  assert.deepEqual(s.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(s.rolledSeq, 0);
  assert.equal(store.totalBytes, s.bytes);
});

test('an event larger than the session is refused and nothing is dropped', () => {
  const { store, s } = setup();
  store.append(s, note());
  assert.throws(() => store.append(s, note('x'.repeat(2000))), { code: 'TOO_LARGE' });
  assert.equal(s.events.length, 1);
  assert.equal(s.rolledSeq, 0);
});

test('a preview over maxPreviewBytes is refused', () => {
  const { store, s } = setup();
  assert.throws(() => store.append(s, { ...image(), pct: 'x'.repeat(101) }), { code: 'TOO_LARGE' });
  assert.equal(s.events.length, 0);
});

test('used is 0 when empty, 1000 at the limit and rounded up in between', () => {
  const { store, s } = setup({ maxEvents: 1000, maxSessionBytes: 10000 });
  assert.equal(store.used(s), 0);
  store.append(s, note()); // 83 bytes of 10000
  assert.equal(store.used(s), 9);
  store.append(s, note('x'.repeat(9837)));
  assert.equal(store.used(s), 1000);
  const t = setup({ maxEvents: 4, maxSessionBytes: 1e6 });
  t.store.append(t.s, note());
  assert.equal(t.store.used(t.s), 250);
});

test('deleting an image frees its bytes', () => {
  const { store, s } = setup();
  store.memberUp(s, 'a'); store.memberUp(s, 'b');
  store.append(s, image('a'));
  const del = store.deleteNote(s, 1);
  assert.equal(del.kind, 'delete');
  assert.equal(s.bytes, 0);
  assert.equal(store.totalBytes, 0);
});
