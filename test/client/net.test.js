// Tests for the browser network module against a real server: api(), connectLive() and reconnects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, connectLive } from '../../public/js/net.js';
import { start } from '../helpers.js';

const AUTH = 'a'.repeat(64);
const IV = 'A'.repeat(16);
let counter = 0;
const newId = () => `${String(20 + counter++).padStart(2, '0')}-dancing-apes`;

/** Start a server and a session; the server is closed after the test. */
async function setup(t, overrides = {}) {
  const { url, app } = await start(overrides);
  t.after(() => app.close());
  const id = newId();
  const base = { id, auth: AUTH, client: 'tester-1' };
  const res = await api('create', { ...base, hours: 24 }, url);
  assert.equal(res.status, 200);
  const add = (ct) => api('add', { ...base, kind: 'note', iv: IV, ct }, url);
  return { url, app, id, base, add };
}

/** WebSocket subclass that records every instance it creates. */
function recorder() {
  const sockets = [];
  class Rec extends WebSocket {
    constructor(u, p) { super(u, p); this.requestedUrl = String(u); sockets.push(this); }
  }
  return { sockets, Rec };
}

/** Collects calls and lets a test wait until a predicate holds. */
function until(pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function tick() {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    })();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveOpts(s, extra = {}) {
  const log = { welcomes: [], events: [], status: [], errors: [], ended: [] };
  const opts = {
    base: s.url,
    hello: () => ({ id: s.id, auth: AUTH, client: 'tester-2', since: -1 }),
    onWelcome: (m, o) => log.welcomes.push({ m, o }),
    onEvents: (e) => log.events.push(...e),
    onStatus: (x) => log.status.push(x),
    onError: (c) => log.errors.push(c),
    onEnded: (r) => log.ended.push(r),
    delays: [10],
    ...extra,
  };
  return { opts, log };
}

test('api create and add', async (t) => {
  const s = await setup(t);
  const res = await s.add('abc');
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { seq: 1 });
});

test('api network failure', async () => {
  const res = await api('add', {}, 'http://127.0.0.1:9/');
  assert.equal(res.status, 0);
  assert.equal(res.data.error, 'CONNECTION');
});

test('api non-JSON response', async (t) => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => { res.statusCode = 502; res.end('<html>bad gateway</html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const res = await api('add', {}, `http://127.0.0.1:${srv.address().port}/`);
  assert.deepEqual(res, { status: 502, data: { error: 'INTERNAL' } });
});

test('url has no token', async (t) => {
  const s = await setup(t);
  const { sockets, Rec } = recorder();
  const { opts, log } = liveOpts(s);
  const live = connectLive(opts, Rec);
  t.after(() => live.close());
  await until(() => log.welcomes.length === 1);
  const expected = `ws://127.0.0.1:${new URL(s.url).port}/ws`;
  assert.ok(sockets.length >= 1);
  for (const sock of sockets) {
    assert.equal(sock.requestedUrl, expected);
    assert.ok(!sock.requestedUrl.includes('?'));
    assert.ok(!sock.requestedUrl.includes(AUTH));
  }
});

test('welcome then events', async (t) => {
  const s = await setup(t);
  const { opts, log } = liveOpts(s);
  const live = connectLive(opts);
  t.after(() => live.close());
  await until(() => log.welcomes.length === 1);
  assert.equal(log.welcomes[0].m.mode, 'snapshot');
  assert.equal(log.welcomes[0].o.reset, true);
  await until(() => log.status.includes('online'));
  await s.add('first');
  await until(() => log.events.length === 1);
  assert.equal(log.events[0].seq, 1);
  assert.equal(log.events[0].ct, 'first');
});

test('reconnects with since after a drop', async (t) => {
  const s = await setup(t);
  await s.add('one');
  const { sockets, Rec } = recorder();
  const hellos = [];
  const { opts, log } = liveOpts(s);
  let lastSeq = -1;
  opts.hello = () => ({ id: s.id, auth: AUTH, client: 'tester-2', since: -1 });
  const live = connectLive(opts, class extends Rec {
    send(d) { hellos.push(JSON.parse(d)); super.send(d); }
  });
  t.after(() => live.close());
  await until(() => log.welcomes.length === 1);
  lastSeq = Math.max(...log.welcomes[0].m.events.map((e) => e.seq));
  assert.equal(lastSeq, 1);
  sockets[0].close(); // simulate a network drop
  await until(() => log.status.includes('reconnecting'));
  await s.add('two');
  await until(() => log.welcomes.length === 2);
  assert.equal(sockets.length, 2);
  assert.equal(hellos[1].since, lastSeq);
  assert.equal(hellos[1].type, 'hello');
  assert.equal(log.welcomes[1].m.mode, 'delta');
  assert.equal(log.welcomes[1].o.reset, false);
  await sleep(50);
  const all = [...log.welcomes.flatMap((w) => w.m.events), ...log.events].filter((e) => e.ct === 'two');
  assert.equal(all.length, 1);
});

test('no reconnect after NOT_FOUND', async (t) => {
  const s = await setup(t);
  const { sockets, Rec } = recorder();
  const { opts, log } = liveOpts(s);
  opts.hello = () => ({ id: '99-missing-id', auth: AUTH, client: 'tester-2', since: -1 });
  const live = connectLive(opts, Rec);
  t.after(() => live.close());
  await until(() => log.errors.length === 1);
  assert.deepEqual(log.errors, ['NOT_FOUND']);
  await sleep(100);
  assert.equal(sockets.length, 1);
  assert.ok(!log.status.includes('reconnecting'));
});

test('a refused connection (RATE_LIMITED) is reported as busy and retried with back-off, not given up and not in a tight loop', async (t) => {
  const s = await setup(t, { maxSocketsPerSession: 1 });
  const first = liveOpts(s);
  const holder = connectLive(first.opts);
  t.after(() => holder.close());
  await until(() => first.log.welcomes.length === 1);
  const { sockets, Rec } = recorder();
  const { opts, log } = liveOpts(s, { delays: [100] });
  const live = connectLive(opts, Rec);
  t.after(() => live.close());
  await sleep(450);
  assert.deepEqual(log.errors, [], 'RATE_LIMITED is not fatal');
  assert.equal(log.welcomes.length, 0);
  assert.ok(log.status.length >= 1 && log.status.every((x) => x === 'busy'), `busy, not reconnecting: ${log.status}`);
  assert.ok(sockets.length >= 2 && sockets.length <= 6, `${sockets.length} attempts in 450 ms with a 100 ms delay`);
  holder.close(); // a place becomes free: the next attempt gets in
  await until(() => log.welcomes.length === 1);
  assert.equal(log.status.at(-1), 'online');
});

test('a drop after being busy is reported as reconnecting again', async (t) => {
  const s = await setup(t, { maxSocketsPerSession: 1 });
  const first = liveOpts(s);
  const holder = connectLive(first.opts);
  t.after(() => holder.close());
  await until(() => first.log.welcomes.length === 1);
  const { sockets, Rec } = recorder();
  const { opts, log } = liveOpts(s, { delays: [50] });
  const live = connectLive(opts, Rec);
  t.after(() => live.close());
  await until(() => log.status.includes('busy'));
  holder.close();
  await until(() => log.welcomes.length === 1);
  sockets.at(-1).close(); // an ordinary drop
  await until(() => log.status.at(-1) === 'reconnecting');
});

test('no reconnect after ended', async (t) => {
  const s = await setup(t);
  const { sockets, Rec } = recorder();
  const { opts, log } = liveOpts(s);
  const live = connectLive(opts, Rec);
  t.after(() => live.close());
  await until(() => log.welcomes.length === 1);
  await api('end', s.base, s.url);
  await until(() => log.ended.length === 1);
  assert.equal(log.ended[0], 'ended');
  await sleep(100);
  assert.equal(sockets.length, 1);
});

test('close() stops it for good', async (t) => {
  const s = await setup(t);
  const { sockets, Rec } = recorder();
  const { opts, log } = liveOpts(s);
  const live = connectLive(opts, Rec);
  await until(() => log.welcomes.length === 1);
  sockets[0].close();
  await until(() => log.status.includes('reconnecting'));
  live.close(); // while a reconnect is pending
  live.close(); // twice is safe
  await sleep(100);
  assert.equal(sockets.length, 1);

  const second = connectLive(opts, Rec);
  await until(() => sockets.length === 2);
  second.close();
  await sleep(100);
  assert.equal(sockets.length, 2);
});
