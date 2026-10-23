// Tests for the in-memory session store: limits, events, snapshots, expiry and sweeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { SessionStore, hashAuth } from '../src/store.js';

const IV = 'AAAAAAAAAAAAAAAA';
const AUTH = 'a'.repeat(64);

function setup(overrides = {}) {
  const clock = { t: 1_700_000_000_000 };
  const config = { ...loadConfig({}), ...overrides };
  const store = new SessionStore(config, () => clock.t);
  return { clock, config, store, hash: hashAuth(AUTH) };
}
const secs = (clock) => Math.floor(clock.t / 1000);
const note = (ct = 'abc', kind = 'note') => ({ kind, client: 'clientA1', iv: IV, ct });

test('hashAuth is sha256 of the hex string text', () => {
  assert.equal(hashAuth(AUTH), createHash('sha256').update(AUTH, 'utf8').digest('hex'));
});

test('MAX_HOURS from the config caps create and setExpiry', () => {
  const { clock, store, hash } = setup({ maxHours: 48 });
  assert.equal(store.create({ id: '14-aa-bb', authHash: hash, hours: 168 }).expires, secs(clock) + 48 * 3600);
  assert.equal(store.setExpiry(store.get('14-aa-bb'), 500), secs(clock) + 48 * 3600);
});

test('defaultHours from the config is used when hours is missing', () => {
  const { clock, store, hash } = setup({ defaultHours: 8 });
  assert.equal(store.create({ id: '15-aa-bb', authHash: hash }).expires, secs(clock) + 8 * 3600);
});

test('create defaults to 24h and clamps hours', () => {
  const { clock, store, hash } = setup();
  assert.equal(store.create({ id: '11-aa-bb', authHash: hash }).expires, secs(clock) + 86400);
  assert.equal(store.create({ id: '12-aa-bb', authHash: hash, hours: 999 }).expires, secs(clock) + 168 * 3600);
  assert.equal(store.create({ id: '13-aa-bb', authHash: hash, hours: 0 }).expires, secs(clock) + 3600);
  assert.equal(store.size, 3);
});

test('create twice throws TAKEN', () => {
  const { store, hash } = setup();
  store.create({ id: '11-aa-bb', authHash: hash });
  assert.throws(() => store.create({ id: '11-aa-bb', authHash: hash }), { code: 'TAKEN' });
});

test('maxSessions reached throws SERVER_FULL', () => {
  const { store, hash } = setup({ maxSessions: 2 });
  store.create({ id: '11-aa-bb', authHash: hash });
  store.create({ id: '12-aa-bb', authHash: hash });
  assert.throws(() => store.create({ id: '13-aa-bb', authHash: hash }), { code: 'SERVER_FULL' });
});

test('check returns the session only for the right hash', () => {
  const { store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  assert.equal(store.check('11-aa-bb', hash), s);
  assert.equal(store.check('11-aa-bb', hashAuth('b'.repeat(64))), null);
  assert.equal(store.check('11-aa-bb', 'short'), null);
  assert.equal(store.check('99-zz-zz', hash), null);
});

test('append assigns seq 1,2,3 and emits', () => {
  const { clock, store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  const seen = [];
  store.on('event', (id, ev) => seen.push([id, ev]));
  const e1 = store.append(s, note());
  const e2 = store.append(s, note());
  const e3 = store.append(s, note('xyz', 'meta'));
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);
  assert.equal(s.lastSeq, 3);
  assert.deepEqual(seen[0], ['11-aa-bb', { seq: 1, ts: secs(clock), kind: 'note', client: 'clientA1', iv: IV, ct: 'abc' }]);
  assert.equal(seen.length, 3);
});

test('burn events are wired without iv or ct', () => {
  const { store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  const ev = store.append(s, note('abcd', 'burn'));
  assert.equal(ev.kind, 'burn');
  assert.equal('ct' in ev, false);
  assert.equal('iv' in ev, false);
  assert.equal(ev.size, 4);
});

test('append limits', () => {
  let { store, hash } = setup({ maxNoteBytes: 10, maxMetaBytes: 5 });
  let s = store.create({ id: '11-aa-bb', authHash: hash });
  assert.throws(() => store.append(s, note('x'.repeat(11))), { code: 'TOO_LARGE' });
  assert.throws(() => store.append(s, note('x'.repeat(6), 'meta')), { code: 'TOO_LARGE' });
  assert.equal(s.lastSeq, 0);

  ({ store, hash } = setup({ maxEvents: 2 }));
  s = store.create({ id: '11-aa-bb', authHash: hash });
  store.append(s, note()); store.append(s, note());
  assert.throws(() => store.append(s, note()), { code: 'SESSION_FULL' });

  ({ store, hash } = setup({ maxSessionBytes: 200 }));
  s = store.create({ id: '11-aa-bb', authHash: hash });
  store.append(s, note('x'.repeat(50))); // 50 + 16 + 64 = 130
  assert.throws(() => store.append(s, note('x'.repeat(50))), { code: 'SESSION_FULL' });

  ({ store, hash } = setup({ maxTotalBytes: 200 }));
  s = store.create({ id: '11-aa-bb', authHash: hash });
  const s2 = store.create({ id: '12-aa-bb', authHash: hash });
  store.append(s, note('x'.repeat(50)));
  assert.throws(() => store.append(s2, note('x'.repeat(50))), { code: 'SERVER_FULL' });
});

test('deleteNote removes ciphertext and frees bytes', () => {
  const { store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  const n = store.append(s, note('x'.repeat(100)));
  const before = store.totalBytes;
  const seen = [];
  store.on('event', (id, ev) => seen.push(ev));
  const del = store.deleteNote(s, n.seq);
  assert.equal(del.kind, 'delete');
  assert.equal(del.target, n.seq);
  assert.deepEqual(seen, [del]);
  const { events } = store.eventsSince(s, -1);
  assert.ok(!events.some((e) => e.seq === n.seq));
  assert.ok(events.some((e) => e.kind === 'delete' && e.target === n.seq));
  assert.ok(store.totalBytes < before);
  assert.equal(s.bytes, store.totalBytes);
});

test('deleteNote rejects meta and unknown', () => {
  const { store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  const m = store.append(s, note('abc', 'meta'));
  assert.throws(() => store.deleteNote(s, m.seq), { code: 'GONE' });
  assert.throws(() => store.deleteNote(s, 99), { code: 'GONE' });
});

test('clear leaves one clear event and zero bytes', () => {
  const { store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  store.append(s, note()); store.append(s, note());
  const seqBefore = s.lastSeq;
  const ev = store.clear(s);
  assert.equal(ev.kind, 'clear');
  const { events } = store.eventsSince(s, -1);
  assert.deepEqual(events.map((e) => e.kind), ['clear']);
  assert.equal(s.bytes, 0);
  assert.equal(store.totalBytes, 0);
  assert.equal(store.eventsSince(s, seqBefore).mode, 'snapshot');
});

test('seq is never reused after clear', () => {
  const { store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  store.append(s, note());
  const c = store.clear(s);
  assert.equal(store.append(s, note()).seq, c.seq + 1);
});

test('eventsSince snapshot and delta rules', () => {
  const { store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  for (let i = 0; i < 3; i++) store.append(s, note());
  assert.equal(store.eventsSince(s, -1).mode, 'snapshot');
  assert.equal(store.eventsSince(s, -1).events.length, 3);
  const d = store.eventsSince(s, s.lastSeq - 1);
  assert.equal(d.mode, 'delta');
  assert.deepEqual(d.events.map((e) => e.seq), [3]);
  assert.equal(store.eventsSince(s, s.lastSeq).events.length, 0);
  assert.equal(store.eventsSince(s, s.lastSeq + 5).mode, 'snapshot');
});

test('setExpiry clamps and emits session', () => {
  const { clock, store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  const seen = [];
  store.on('session', (id, info) => seen.push([id, info]));
  assert.equal(store.setExpiry(s, 8), secs(clock) + 8 * 3600);
  assert.equal(store.setExpiry(s, 5000), secs(clock) + 168 * 3600);
  assert.equal(store.setExpiry(s, 0), secs(clock) + 3600);
  assert.equal(s.expires, secs(clock) + 3600);
  assert.deepEqual(seen[0], ['11-aa-bb', { expires: secs(clock) + 8 * 3600 }]);
  assert.equal(seen.length, 3);
});

test('end emits ended and frees bytes', () => {
  const { store, hash } = setup();
  const keep = store.create({ id: '12-aa-bb', authHash: hash });
  store.append(keep, note());
  const base = store.totalBytes;
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  store.append(s, note('x'.repeat(100)));
  const seen = [];
  store.on('ended', (id, reason) => seen.push([id, reason]));
  store.end('11-aa-bb', 'ended');
  assert.deepEqual(seen, [['11-aa-bb', 'ended']]);
  assert.equal(store.get('11-aa-bb'), undefined);
  assert.equal(store.totalBytes, base);
  store.end('99-zz-zz', 'ended'); // unknown id is a no-op
  assert.equal(seen.length, 1);
});

test('sweep ends expired sessions', () => {
  const { clock, store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash, hours: 1 });
  store.setPresence(s, 1);
  const seen = [];
  store.on('ended', (id, reason) => seen.push([id, reason]));
  clock.t += 3599_000; store.sweep();
  assert.equal(store.size, 1);
  clock.t += 1_000; store.sweep();
  assert.deepEqual(seen, [['11-aa-bb', 'expired']]);
  assert.equal(store.size, 0);
});

test('sweep ends idle sessions after idleSeconds without presence', () => {
  const { clock, store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  store.setPresence(s, 1);
  clock.t += 10_000;
  store.setPresence(s, 0);
  const seen = [];
  store.on('ended', (id, reason) => seen.push([id, reason]));
  clock.t += 119_000; store.sweep();
  assert.equal(store.size, 1);
  clock.t += 2_000; store.sweep();
  assert.deepEqual(seen, [['11-aa-bb', 'idle']]);
});

test('sweep keeps sessions with presence', () => {
  const { clock, store, hash } = setup();
  const s = store.create({ id: '11-aa-bb', authHash: hash });
  store.setPresence(s, 1);
  clock.t += 600_000; store.sweep();
  assert.equal(store.size, 1);
  assert.equal(s.present, 1);
});

test('a session never joined counts as empty from creation', () => {
  const { clock, store, hash } = setup();
  store.create({ id: '11-aa-bb', authHash: hash });
  clock.t += 121_000; store.sweep();
  assert.equal(store.size, 0);
});
