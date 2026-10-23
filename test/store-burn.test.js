// Tests for burn-after-reading notes in the store: hidden ciphertext, single release, accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { SessionStore, hashAuth } from '../src/store.js';

const IV = 'AAAAAAAAAAAAAAAA';
const CT = 'secret-ciphertext';

function setup() {
  const clock = { t: 1_700_000_000_000 };
  const store = new SessionStore(loadConfig({}), () => clock.t);
  const s = store.create({ id: '11-aa-bb', authHash: hashAuth('a'.repeat(64)) });
  const events = [];
  store.on('event', (id, ev) => events.push(ev));
  return { clock, store, s, events };
}
const burn = (ct = CT) => ({ kind: 'burn', client: 'clientA1', iv: IV, ct });
const hidden = (ev) => !('ct' in ev) && !('iv' in ev);

test('burn wire event hides ciphertext', () => {
  const { store, s, events } = setup();
  const ev = store.append(s, burn());
  assert.deepEqual(ev, { seq: 1, ts: 1_700_000_000, kind: 'burn', client: 'clientA1', size: CT.length });
  assert.ok(hidden(ev) && hidden(events[0]));
  assert.ok(hidden(store.eventsSince(s, -1).events[0]));
  store.append(s, { kind: 'note', client: 'clientA1', iv: IV, ct: 'x' });
  const delta = store.eventsSince(s, 0);
  assert.equal(delta.mode, 'delta');
  assert.ok(hidden(delta.events[0]));
});

test('burnOpen returns ciphertext once', () => {
  const { store, s, events } = setup();
  const { seq } = store.append(s, burn());
  const before = s.bytes;
  assert.deepEqual(store.burnOpen(s, seq, 'clientB1'), { iv: IV, ct: CT });
  const last = events.at(-1);
  assert.deepEqual(last, { seq: 2, ts: 1_700_000_000, kind: 'burned', target: seq, client: 'clientB1' });
  assert.equal(s.bytes, before - CT.length - IV.length);
  assert.equal(store.totalBytes, s.bytes);
  assert.throws(() => store.burnOpen(s, seq, 'clientB1'), { code: 'GONE' });
  assert.throws(() => store.burnOpen(s, seq, 'clientC1'), { code: 'GONE' });
});

test('opened placeholder stays in snapshots with the same size and no ciphertext', () => {
  const { store, s } = setup();
  const { seq } = store.append(s, burn());
  store.burnOpen(s, seq, 'clientB1');
  const { events } = store.eventsSince(s, -1);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { seq, ts: 1_700_000_000, kind: 'burn', client: 'clientA1', size: CT.length });
  assert.equal(events[1].kind, 'burned');
  assert.ok(events.every(hidden));
});

test('burnOpen refuses the sender', () => {
  const { store, s } = setup();
  const { seq } = store.append(s, burn());
  assert.throws(() => store.burnOpen(s, seq, 'clientA1'), { code: 'FORBIDDEN' });
  assert.deepEqual(store.burnOpen(s, seq, 'clientB1'), { iv: IV, ct: CT });
});

test('burnOpen on note or unknown seq throws GONE', () => {
  const { store, s } = setup();
  const { seq } = store.append(s, { kind: 'note', client: 'clientA1', iv: IV, ct: 'x' });
  assert.throws(() => store.burnOpen(s, seq, 'clientB1'), { code: 'GONE' });
  assert.throws(() => store.burnOpen(s, 99, 'clientB1'), { code: 'GONE' });
});

test('simultaneous opens: exactly one wins', async () => {
  const { store, s } = setup();
  const { seq } = store.append(s, burn());
  const results = await Promise.allSettled([1, 2].map(async (i) => store.burnOpen(s, seq, 'reader' + i + 'x')));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('unopened burn can be deleted', () => {
  const { store, s } = setup();
  const { seq } = store.append(s, burn());
  store.deleteNote(s, seq);
  assert.equal(s.bytes, 0);
  assert.equal(store.totalBytes, 0);
  assert.throws(() => store.burnOpen(s, seq, 'clientB1'), { code: 'GONE' });
});

test('deleting an opened burn placeholder leaves no bytes behind', () => {
  const { store, s } = setup();
  const { seq } = store.append(s, burn());
  store.burnOpen(s, seq, 'clientB1');
  store.deleteNote(s, seq);
  assert.equal(s.bytes, 0);
  assert.equal(store.totalBytes, 0);
});
