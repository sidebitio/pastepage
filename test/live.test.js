// Tests for the live WebSocket layer: hello auth, presence, broadcasts, burn privacy, image receipts, usage, end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { WebSocket as WsClient } from 'ws';
import { start, post } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { liveLimits } from '../src/live.js';

const AUTH = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);
const IV = 'A'.repeat(16);
let counter = 0;
const newId = () => `${String(10 + counter++).padStart(2, '0')}-blue-owl`;
let clientCounter = 0;
const newClient = (name) => `${name}-${clientCounter++}`.padEnd(6, '_');

/** Poll until cond() holds (server-side counters change a moment after the client sees a close). */
async function waitFor(cond, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the server');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function server(overrides) {
  const s = await start(overrides);
  after(() => s.app.close());
  return s;
}

async function createSession(url) {
  const id = newId();
  const res = await post(url, 'create', { id, auth: AUTH, client: 'creator-0', hours: 24 });
  assert.equal(res.status, 200);
  return id;
}

/** Open a WebSocket; records raw messages, and next(type) resolves the next message of that type. */
function openWs(url) {
  const ws = new WebSocket(url.replace('http', 'ws') + 'ws');
  const messages = [];
  const parsed = [];
  const waiters = [];
  const open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  const closed = new Promise((res) => { ws.onclose = (e) => res(e.code); });
  ws.onmessage = (e) => {
    messages.push(e.data);
    parsed.push(JSON.parse(e.data));
    flush();
  };
  function flush() {
    for (const w of [...waiters]) {
      const i = parsed.findIndex((m) => m.type === w.type);
      if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(parsed.splice(i, 1)[0]); }
    }
  }
  function next(type, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const w = { type, resolve };
      w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timeout waiting for ${type}`)); }, timeoutMs);
      waiters.push(w);
      flush();
    });
  }
  after(() => { try { ws.close(); } catch { /* already closed */ } });
  return { ws, messages, next, open, closed };
}

async function join(url, id, client, { auth = AUTH, since = -1 } = {}) {
  const c = openWs(url);
  await c.open;
  c.ws.send(JSON.stringify({ type: 'hello', id, auth, client, since }));
  return c;
}

const add = (url, id, extra = {}, headers = {}) => post(url, 'add', { id, auth: AUTH, client: 'creator-0', kind: 'note', iv: IV, ct: 'abc', ...extra }, headers);

test('hello timeout closes with 4001', async () => {
  const { url } = await server({ helloTimeoutMs: 200 });
  const c = openWs(url);
  assert.equal(await c.closed, 4001);
});

test('bad hello shapes get BAD_REQUEST and 4001', async () => {
  const { url } = await server();
  const id = await createSession(url);
  for (const msg of ['nope', JSON.stringify({ type: 'hello', id, auth: 'x', client: 'creator-0', since: -1 }), JSON.stringify({ type: 'hello', id, auth: AUTH, client: 'creator-0', since: 1.5 })]) {
    const c = openWs(url);
    await c.open;
    c.ws.send(msg);
    assert.equal((await c.next('error')).code, 'BAD_REQUEST');
    assert.equal(await c.closed, 4001);
  }
});

test('wrong tokens and unknown sessions get NOT_FOUND over the live connection, and never count toward the lockout', async () => {
  const { url, app } = await server({ maxFails: 3 });
  const id = await createSession(url);
  for (let i = 0; i < 12; i++) {
    for (const [sid, auth] of [[id, WRONG], ['99-no-such', AUTH]]) {
      const c = await join(url, sid, 'intruder-1', { auth });
      assert.equal((await c.next('error')).code, 'NOT_FOUND');
      assert.equal(await c.closed, 4001);
    }
  }
  assert.equal(app.failures.size, 0, 'no failure was counted');
  const c = await join(url, id, 'creator-0');
  await c.next('welcome');
});

test('an address locked out through the API is refused on the live connection', async () => {
  const { url } = await server({ maxFails: 3 });
  const id = await createSession(url);
  const from = { 'x-forwarded-for': '203.0.113.41' };
  for (let i = 0; i < 3; i++) assert.equal((await add(url, id, { auth: WRONG }, from)).status, 404);
  assert.equal((await add(url, id, {}, from)).data.error, 'LOCKED');
  const c = await joinFrom(url, id, 'ada-client', '203.0.113.41');
  assert.equal((await c.next('error')).code, 'LOCKED');
  assert.equal(await c.closed, 4001);
  const other = await joinFrom(url, id, 'linus-client', '203.0.113.42');
  await other.next('welcome');
});

test('welcome snapshot after two adds', async () => {
  const { url } = await server();
  const id = await createSession(url);
  await add(url, id);
  await add(url, id);
  const c = await join(url, id, 'ada-client');
  const w = await c.next('welcome');
  assert.equal(w.mode, 'snapshot');
  assert.equal(w.events.length, 2);
  assert.equal(w.present, 1);
  assert.equal(typeof w.expires, 'number');
  assert.equal(typeof w.now, 'number');
});

test('a second message after hello is ignored', async () => {
  const { url } = await server();
  const id = await createSession(url);
  const c = await join(url, id, 'ada-client');
  await c.next('welcome');
  c.ws.send(JSON.stringify({ type: 'hello', id, auth: WRONG, client: 'ada-client', since: -1 }));
  c.ws.send('garbage');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test('presence counts distinct clients', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await join(url, id, 'ada-client');
  assert.equal((await a.next('welcome')).present, 1);
  const b1 = await join(url, id, 'linus-client');
  assert.equal((await b1.next('welcome')).present, 2);
  assert.equal((await a.next('presence')).present, 2);
  const b2 = await join(url, id, 'linus-client');
  assert.equal((await b2.next('welcome')).present, 2);
  b1.ws.close();
  await b1.closed;
  await waitFor(() => app.liveStats().open === 2); // the server has handled the close
  assert.equal(app.store.get(id).present, 2);
  assert.ok(!a.messages.some((m) => JSON.parse(m).type === 'presence' && JSON.parse(m).present !== 2));
  b2.ws.close();
  assert.equal((await a.next('presence')).present, 1);
  assert.equal(app.store.get(id).present, 1);
});

test('presence feeds the store when the last socket closes', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await join(url, id, 'ada-client');
  await a.next('welcome');
  assert.equal(app.store.get(id).present, 1);
  a.ws.close();
  await a.closed;
  await waitFor(() => app.liveStats().open === 0);
  assert.equal(app.store.get(id).present, 0);
});

test('events broadcast to every socket', async () => {
  const { url } = await server();
  const id = await createSession(url);
  const a = await join(url, id, 'ada-client');
  const b = await join(url, id, 'linus-client');
  await a.next('welcome');
  await b.next('welcome');
  const { data } = await add(url, id);
  for (const c of [a, b]) {
    const m = await c.next('events');
    assert.equal(m.events.length, 1);
    assert.equal(m.events[0].seq, data.seq);
    assert.equal(m.events[0].kind, 'note');
  }
});

test('burn ciphertext never goes over the wire', async () => {
  const { url } = await server();
  const id = await createSession(url);
  const a = await join(url, id, 'ada-client');
  await a.next('welcome');
  const { status, data } = await add(url, id, { kind: 'burn', ct: 'SECRET' + 'x'.repeat(40) });
  assert.equal(status, 200);
  const m = await a.next('events');
  assert.equal(m.events[0].kind, 'burn');
  const late = await join(url, id, 'linus-client');
  const w = await late.next('welcome');
  assert.equal(w.events[0].seq, data.seq);
  for (const c of [a, late]) assert.ok(!c.messages.some((s) => s.includes('SECRET')));
});

test('delta and snapshot on reconnect', async () => {
  const { url } = await server();
  const id = await createSession(url);
  const first = (await add(url, id)).data.seq;
  const last = (await add(url, id)).data.seq;
  const del = await post(url, 'delete', { id, auth: AUTH, client: 'creator-0', target: first });
  assert.equal(del.status, 200);
  const fresh = (await add(url, id)).data.seq;
  const c = await join(url, id, 'ada-client', { since: last });
  const w = await c.next('welcome');
  assert.equal(w.mode, 'delta');
  assert.deepEqual(w.events.map((e) => e.kind), ['delete', 'note']);
  assert.equal(w.events[1].seq, fresh);
  await post(url, 'clear', { id, auth: AUTH, client: 'creator-0' });
  const c2 = await join(url, id, 'linus-client', { since: fresh });
  assert.equal((await c2.next('welcome')).mode, 'snapshot');
});

test('session expiry changes are pushed', async () => {
  const { url } = await server();
  const id = await createSession(url);
  const a = await join(url, id, 'ada-client');
  await a.next('welcome');
  const { data } = await post(url, 'expire', { id, auth: AUTH, client: 'creator-0', hours: 8 });
  assert.equal((await a.next('session')).expires, data.expires);
});

test('end sends ended and closes with 4000', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await join(url, id, 'ada-client');
  const b = await join(url, id, 'linus-client');
  await a.next('welcome');
  await b.next('welcome');
  await post(url, 'end', { id, auth: AUTH, client: 'creator-0' });
  for (const c of [a, b]) {
    assert.equal((await c.next('ended')).reason, 'ended');
    assert.equal(await c.closed, 4000);
  }
  assert.equal(app.store.get(id), undefined);
});

test('only /ws upgrades; other paths and oversized messages are refused', async () => {
  const { url } = await server();
  const bad = new WebSocket(url.replace('http', 'ws') + 'other');
  await new Promise((res) => { bad.onerror = res; bad.onclose = res; });
  assert.notEqual(bad.readyState, WebSocket.OPEN);
  const c = openWs(url);
  await c.open;
  c.ws.send('x'.repeat(5000));
  const code = await c.closed;
  assert.equal(code, 1009);
});

/** A masked client text frame (payloads of 126 to 65535 bytes use the 16-bit length). */
function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  const head = Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, mask, body]);
}

test('a hello after the deadline is refused while the close is still pending', async () => {
  const { url, app } = await server({ helloTimeoutMs: 100 });
  const id = await createSession(url);
  const other = await join(url, id, 'ada-client');
  await other.next('welcome');
  const before = app.store.get(id).present;

  // Raw upgrade that never answers the server's close frame.
  const port = new URL(url).port;
  const raw = net.connect(Number(port), '127.0.0.1');
  after(() => raw.destroy());
  const received = [];
  raw.on('data', (d) => received.push(d));
  raw.on('error', () => {});
  await new Promise((res) => raw.once('connect', res));
  raw.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await new Promise((r) => setTimeout(r, 300)); // well past the 100 ms deadline; the 4001 close frame has been sent
  const hello = JSON.stringify({ type: 'hello', id, auth: AUTH, client: 'late-client', since: -1 });
  raw.write(maskedTextFrame(hello));
  await new Promise((r) => setTimeout(r, 200));

  const text = Buffer.concat(received).toString('latin1');
  assert.ok(!text.includes('"welcome"'), 'no welcome after the deadline');
  assert.equal(app.store.get(id).present, before);
  assert.equal(other.messages.filter((m) => JSON.parse(m).type === 'presence').length, 0);
});

test('a silent pending socket that ignores the close frame frees its pending slot within 3 s', async () => {
  const { url, app } = await server({ helloTimeoutMs: 100 });
  const raw = net.connect(Number(new URL(url).port), '127.0.0.1');
  after(() => raw.destroy());
  raw.on('error', () => {}); // never reads the close frame, never closes
  await new Promise((res) => raw.once('connect', res));
  raw.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await waitFor(() => app.liveStats().pending === 1);
  await waitFor(() => app.liveStats().pending === 0, 3000);
});

/**
 * Open a WebSocket with the ws client, so request headers (X-Forwarded-For, Sec-Fetch-Site) can be set.
 * opened resolves true on open, or false when the handshake is refused (then status is the HTTP status).
 */
function wsFrom(url, headers = {}) {
  const ws = new WsClient(url.replace('http', 'ws') + 'ws', { headers });
  const parsed = [];
  const waiters = [];
  const result = { ws, status: 0, parsed };
  ws.on('error', () => {});
  result.opened = new Promise((res) => {
    ws.once('open', () => res(true));
    ws.once('unexpected-response', (req, r) => { result.status = r.statusCode; req.destroy(); res(false); });
    ws.once('close', () => res(false));
  });
  result.closed = new Promise((res) => ws.once('close', (code) => res(code)));
  ws.on('message', (data) => {
    parsed.push(JSON.parse(String(data)));
    for (const w of [...waiters]) {
      const i = parsed.findIndex((m) => m.type === w.type);
      if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(parsed.splice(i, 1)[0]); }
    }
  });
  result.next = (type, timeoutMs = 2000) => new Promise((resolve, reject) => {
    const i = parsed.findIndex((m) => m.type === type);
    if (i >= 0) return resolve(parsed.splice(i, 1)[0]);
    const w = { type, resolve };
    w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timeout waiting for ${type}`)); }, timeoutMs);
    waiters.push(w);
  });
  result.hello = (id, client, auth = AUTH) => ws.send(JSON.stringify({ type: 'hello', id, auth, client, since: -1 }));
  after(() => ws.terminate());
  return result;
}

/** Open a socket from an IP (through X-Forwarded-For) and say hello. */
async function joinFrom(url, id, client, ip) {
  const c = wsFrom(url, { 'x-forwarded-for': ip });
  assert.equal(await c.opened, true);
  c.hello(id, client);
  return c;
}

test('authenticated sockets are capped per IP', async () => {
  const { url, app } = await server({ maxSocketsPerIp: 2 });
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.5');
  const b = await joinFrom(url, id, 'ada-client', '203.0.113.5');
  await a.next('welcome');
  await b.next('welcome');
  const c = await joinFrom(url, id, 'ada-client', '203.0.113.5');
  assert.equal((await c.next('error')).code, 'RATE_LIMITED');
  assert.equal(await c.closed, 4001);
  const other = await joinFrom(url, id, 'linus-client', '203.0.113.6');
  await other.next('welcome');
  assert.equal(app.failures.size, 0, 'a refused socket is not a failed attempt');
  a.ws.close();
  await a.closed;
  await waitFor(() => app.liveStats().open === 2); // b and other
  const again = await joinFrom(url, id, 'ada-client', '203.0.113.5');
  await again.next('welcome');
});

test('IPv6 addresses in one /64 share the per-IP connection caps; other /64s do not', async () => {
  const { url } = await server({ maxSocketsPerIp: 2, maxPendingPerIp: 2 });
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '2001:db8:0:1::1');
  const b = await joinFrom(url, id, 'ada-client', '2001:db8:0:1::2');
  await a.next('welcome');
  await b.next('welcome');
  const c = await joinFrom(url, id, 'ada-client', '2001:db8:0:1:ffff::3');
  assert.equal((await c.next('error')).code, 'RATE_LIMITED');
  const other = await joinFrom(url, id, 'linus-client', '2001:db8:0:2::1');
  await other.next('welcome');

  const p1 = wsFrom(url, { 'x-forwarded-for': '2001:db8:0:5::1' });
  const p2 = wsFrom(url, { 'x-forwarded-for': '2001:db8:0:5::2' });
  assert.equal(await p1.opened, true);
  assert.equal(await p2.opened, true);
  const p3 = wsFrom(url, { 'x-forwarded-for': '2001:db8:0:5::3' });
  assert.equal(await p3.opened, false, 'a third pending socket from the same /64 is refused');
  assert.equal(p3.status, 429);
  const p4 = wsFrom(url, { 'x-forwarded-for': '2001:db8:0:6::1' });
  assert.equal(await p4.opened, true);
});

test('authenticated sockets are capped per session', async () => {
  const { url } = await server({ maxSocketsPerSession: 2 });
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.11');
  const b = await joinFrom(url, id, 'linus-client', '203.0.113.12');
  await a.next('welcome');
  await b.next('welcome');
  const c = await joinFrom(url, id, 'grace-client', '203.0.113.13');
  assert.equal((await c.next('error')).code, 'RATE_LIMITED');
  assert.equal(await c.closed, 4001);
  const elsewhere = await joinFrom(url, await createSession(url), 'grace-client', '203.0.113.13');
  await elsewhere.next('welcome');
});

test('sockets that have not said hello yet are capped per IP', async () => {
  const { url, app } = await server({ maxPendingPerIp: 2 });
  const id = await createSession(url);
  const from = { 'x-forwarded-for': '203.0.113.21' };
  const p1 = wsFrom(url, from);
  const p2 = wsFrom(url, from);
  assert.equal(await p1.opened, true);
  assert.equal(await p2.opened, true);
  const p3 = wsFrom(url, from);
  assert.equal(await p3.opened, false, 'a third pending socket is refused');
  assert.equal(p3.status, 429);
  const elsewhere = wsFrom(url, { 'x-forwarded-for': '203.0.113.22' });
  assert.equal(await elsewhere.opened, true);
  p1.hello(id, 'ada-client'); // no longer pending once it said hello
  await p1.next('welcome');
  const p4 = wsFrom(url, from);
  assert.equal(await p4.opened, true);
  p2.ws.close(); // closing a pending socket frees its place too
  await p2.closed;
  await waitFor(() => app.liveStats().pending === 2); // p4 and elsewhere
  const p5 = wsFrom(url, from);
  assert.equal(await p5.opened, true);
});

test('a socket that stops reading is cut off once too much waits to be sent to it', async () => {
  // A small session keeps the cut-off point low: it is at least one full welcome (see liveLimits), here about 2.4 MB.
  const { url, app } = await server({ maxBufferedBytes: 1024 * 1024, maxSessionBytes: 1_400_000, maxEvents: 200 });
  const id = await createSession(url);
  const reader = await joinFrom(url, id, 'ada-client', '203.0.113.31');
  await reader.next('welcome');
  const slow = await joinFrom(url, id, 'linus-client', '203.0.113.32');
  slow.ws.pause(); // stops reading: everything sent to it piles up on the server
  assert.equal((await reader.next('presence')).present, 2);
  const ct = randomBytes(1_000_000).toString('base64url'); // about 1.3 MB per note
  let cutOff = false;
  for (let i = 0; i < 100 && !cutOff; i++) {
    const { data } = await add(url, id, { ct });
    await post(url, 'delete', { id, auth: AUTH, client: 'creator-0', target: data.seq }); // keeps the session small
    cutOff = app.store.get(id).present === 1;
  }
  assert.ok(cutOff, 'the slow socket was terminated');
  assert.equal((await reader.next('presence')).present, 1);
  assert.equal(reader.ws.readyState, WsClient.OPEN, 'the socket that reads stays connected');
});

test('a broadcast is serialised once, however many sockets receive it', async (t) => {
  const { url } = await server();
  const id = await createSession(url);
  const clients = await Promise.all(['ada-client', 'linus-client', 'grace-client'].map((c) => join(url, id, c)));
  for (const c of clients) await c.next('welcome');
  const calls = t.mock.method(JSON, 'stringify');
  const { data } = await add(url, id);
  const received = await Promise.all(clients.map((c) => c.next('events')));
  const eventMessages = calls.mock.calls.filter((call) => call.arguments[0]?.type === 'events');
  calls.mock.restore();
  assert.equal(eventMessages.length, 1);
  for (const m of received) assert.equal(m.events[0].seq, data.seq);
  assert.equal(new Set(clients.map((c) => c.messages.at(-1))).size, 1, 'every socket got the same text');
});

test('handshakes the browser marks as cross-site or same-site are refused before any hello counts', async () => {
  const { url, app } = await server({ maxFails: 3 });
  const id = await createSession(url);
  for (const site of ['cross-site', 'same-site']) {
    for (let i = 0; i < 4; i++) {
      const c = wsFrom(url, { 'sec-fetch-site': site, origin: 'https://other.example' });
      c.ws.once('open', () => c.hello(id, 'intruder-1', WRONG));
      assert.equal(await c.opened, false, site);
      assert.equal(c.status, 403);
    }
  }
  assert.equal(app.failures.size, 0);
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, {}]) { // no header: Chromium and non-browser clients
    const c = wsFrom(url, headers);
    assert.equal(await c.opened, true);
    c.hello(id, 'ada-client');
    await c.next('welcome');
  }
});

test('sockets that answer pings stay connected', async () => {
  const { url } = await server({ pingMs: 50 });
  const id = await createSession(url);
  const a = await join(url, id, 'ada-client');
  await a.next('welcome');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.ws.readyState, WebSocket.OPEN); // the client answers pings, so it stays
});

test('sockets that stop answering pings are terminated', async () => {
  const { url, app } = await server({ pingMs: 50 });
  const id = await createSession(url);
  const ws = new WsClient(url.replace('http', 'ws') + 'ws', { autoPong: false });
  after(() => ws.terminate());
  const closed = new Promise((res) => ws.on('close', (code) => res(code)));
  ws.on('error', () => {});
  await new Promise((res) => ws.once('open', res));
  ws.send(JSON.stringify({ type: 'hello', id, auth: AUTH, client: 'mute-client', since: -1 }));
  assert.equal(await closed, 1006);
  for (let i = 0; i < 40 && app.store.get(id).present !== 0; i++) await new Promise((r) => setTimeout(r, 25)); // server-side close event may lag the client's
  assert.equal(app.store.get(id).present, 0);
});

test('the connection counters go back to zero once every socket has closed', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.51');
  const b = await joinFrom(url, id, 'linus-client', '2001:db8:0:9::1');
  await a.next('welcome');
  await b.next('welcome');
  const pending = wsFrom(url, { 'x-forwarded-for': '203.0.113.52' });
  assert.equal(await pending.opened, true);
  const leaver = await joinFrom(url, id, 'grace-client', '203.0.113.53');
  await leaver.next('welcome');
  leaver.ws.close();
  await waitFor(() => app.liveStats().open === 2 && app.liveStats().pending === 1);
  for (const c of [a, b, pending]) c.ws.terminate();
  await waitFor(() => app.liveStats().open === 0 && app.liveStats().pending === 0);
});

test('authenticated sockets are capped for the whole server', async () => {
  const { url, app } = await server({ maxSocketsTotal: 2 });
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.81');
  const b = await joinFrom(url, await createSession(url), 'linus-client', '2001:db8:0:81::1');
  await a.next('welcome');
  await b.next('welcome');
  const c = await joinFrom(url, id, 'grace-client', '203.0.113.82');
  assert.equal((await c.next('error')).code, 'RATE_LIMITED');
  assert.equal(await c.closed, 4001);
  assert.equal(app.failures.size, 0, 'a refused socket is not a failed attempt');
  a.ws.close();
  await waitFor(() => app.liveStats().open === 1);
  const d = await joinFrom(url, id, 'grace-client', '203.0.113.82');
  await d.next('welcome');
});

test('sockets that have not said hello yet are capped for the whole server', async () => {
  const { url } = await server({ maxPendingTotal: 2 });
  const id = await createSession(url);
  const p1 = wsFrom(url, { 'x-forwarded-for': '203.0.113.91' });
  const p2 = wsFrom(url, { 'x-forwarded-for': '2001:db8:0:91::1' });
  assert.equal(await p1.opened, true);
  assert.equal(await p2.opened, true);
  const p3 = wsFrom(url, { 'x-forwarded-for': '203.0.113.92' });
  assert.equal(await p3.opened, false, 'a third pending socket is refused, whatever its address');
  assert.equal(p3.status, 429);
  p1.hello(id, 'ada-client');
  await p1.next('welcome');
  const p4 = wsFrom(url, { 'x-forwarded-for': '203.0.113.92' });
  assert.equal(await p4.opened, true);
});

test('the send backlog limit and the welcome budget are never smaller than the largest welcome', () => {
  const MiB = 1024 * 1024;
  assert.deepEqual(liveLimits(loadConfig({})), { sendBacklog: 16 * MiB, welcomeBudget: 256 * MiB });
  const big = { ...loadConfig({}), maxSessionBytes: 30_000_000, maxWelcomeBytesInFlight: 1 };
  const largest = 30_000_000 + 2000 * 256 + MiB;
  assert.deepEqual(liveLimits(big), { sendBacklog: largest, welcomeBudget: largest });
});

/** Fill a session with notes of about 1.49 MB each (it needs a raised maxSessionBytes and maxTotalBytes). */
async function fill(url, id, notes) {
  const ct = randomBytes(1_120_000).toString('base64url');
  for (let i = 0; i < notes; i++) assert.equal((await add(url, id, { ct })).status, 200);
}

test('a page that pauses while a large welcome is on its way is not cut off when someone else joins', async () => {
  const { url, app } = await server({ maxSessionBytes: 30_000_000, maxTotalBytes: 1e9 });
  const id = await createSession(url);
  await fill(url, id, 19); // about 28.4 MB, well past the old fixed 16 MiB limit
  const slow = wsFrom(url, { 'x-forwarded-for': '203.0.113.61' });
  assert.equal(await slow.opened, true);
  slow.ws.pause(); // a slow link: nothing is read for a while, so most of the welcome waits on the server
  slow.hello(id, 'ada-client');
  await waitFor(() => app.liveStats().open === 1);
  const other = await joinFrom(url, id, 'linus-client', '203.0.113.62'); // its presence update goes to the slow page
  assert.equal((await other.next('welcome', 10000)).events.length, 19);
  slow.ws.resume();
  assert.equal((await slow.next('welcome', 10000)).events.length, 19);
  assert.equal((await slow.next('presence')).present, 2);
  assert.equal(slow.ws.readyState, WsClient.OPEN);
});

test('welcomes still waiting to be sent share one budget for the whole server', async (t) => {
  // With maxWelcomeBytesInFlight 1, the budget is its floor: one welcome of the largest possible size.
  const { url, app } = await server({ maxSessionBytes: 30_000_000, maxTotalBytes: 1e9, maxWelcomeBytesInFlight: 1 });
  const id = await createSession(url);
  await fill(url, id, 19);
  const slow = wsFrom(url, { 'x-forwarded-for': '203.0.113.71' });
  assert.equal(await slow.opened, true);
  slow.ws.pause();
  slow.hello(id, 'ada-client');
  await waitFor(() => app.liveStats().open === 1);
  assert.ok(app.liveStats().welcomeBytes > 28_000_000, 'the waiting welcome is counted');
  const encodes = t.mock.method(JSON, 'stringify');
  const second = await joinFrom(url, id, 'linus-client', '203.0.113.72');
  assert.equal((await second.next('error')).code, 'RATE_LIMITED');
  assert.equal(encodes.mock.calls.filter((c) => c.arguments[0]?.type === 'welcome').length, 0, 'refused before its welcome is built');
  encodes.mock.restore();
  assert.equal(await second.closed, 4001);
  assert.equal(app.store.get(id).present, 1, 'a refused page is not registered');
  assert.equal(app.failures.size, 0);
  slow.ws.resume(); // once its welcome has gone out, the budget is free again
  await slow.next('welcome', 10000);
  await waitFor(() => app.liveStats().welcomeBytes === 0);
  const third = await joinFrom(url, id, 'linus-client', '203.0.113.72');
  await third.next('welcome', 10000);
  await waitFor(() => app.liveStats().welcomeBytes === 0);
  const gone = wsFrom(url, { 'x-forwarded-for': '203.0.113.73' });
  assert.equal(await gone.opened, true);
  gone.ws.pause();
  gone.hello(id, 'grace-client');
  await waitFor(() => app.liveStats().welcomeBytes > 0);
  gone.ws.terminate(); // a page that leaves before its welcome went out frees its share too
  await waitFor(() => app.liveStats().welcomeBytes === 0 && app.liveStats().open === 2);
});

/** Post an image from a client: a full version and a preview. */
const addImage = (url, id, client, extra = {}) => add(url, id, { client, kind: 'image', iv: IV, ct: 'full', piv: IV, pct: 'preview', ...extra });
const gotMsg = (seq) => JSON.stringify({ type: 'got', seq });

test('the welcome and every event carry the share key, usage and the rolled-off point', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  await add(url, id);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.91');
  const w = await a.next('welcome');
  assert.equal(w.share, app.store.get(id).share);
  assert.match(w.share, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(w.used, app.store.used(app.store.get(id)));
  assert.ok(w.used > 0);
  assert.equal(w.rolled, 0);
  await add(url, id);
  const m = await a.next('events');
  assert.equal(m.used, app.store.used(app.store.get(id)));
  assert.equal(m.rolled, 0);
});

test('the welcome carries the last clear and the preview limit', async () => {
  const { url, app } = await server({ maxPreviewBytes: 1234, maxEvents: 3 });
  const id = await createSession(url);
  await add(url, id);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.71');
  const w = await a.next('welcome');
  assert.equal(w.maxPreview, 1234);
  assert.equal(w.cleared, 0);
  a.ws.close();
  assert.equal((await post(url, 'clear', { id, auth: AUTH, client: 'creator-0' })).status, 200);
  for (let i = 0; i < 3; i++) await add(url, id); // the clear rolls off
  assert.equal(app.store.get(id).rolledSeq, 2);
  const b = await join(url, id, 'linus-client', { since: 1 }); // it saw note 1, then the clear and more passed
  const w2 = await b.next('welcome');
  assert.equal(w2.mode, 'snapshot');
  assert.ok(w2.events.every((e) => e.kind === 'note'));
  assert.equal(w2.cleared, 2);
  assert.equal(w2.rolled, 2);
});

test('an image is held in full until the other client confirms it, then only its preview is sent', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.92');
  const b = await joinFrom(url, id, 'linus-client', '203.0.113.93');
  await a.next('welcome');
  await b.next('welcome');
  const { data } = await addImage(url, id, 'ada-client');
  const m = await b.next('events');
  assert.equal(m.events[0].kind, 'image');
  assert.equal(m.events[0].ct, 'full');
  assert.equal(m.events[0].full, true);
  const held = (await joinFrom(url, id, 'grace-client', '203.0.113.94')).next('welcome');
  assert.equal((await held).events[0].full, true, 'still held before the receipt');
  b.ws.send(gotMsg(data.seq));
  const usage = await a.next('usage');
  assert.equal(usage.used, app.store.used(app.store.get(id)));
  assert.equal(usage.rolled, 0);
  const c = await joinFrom(url, id, 'grace-client', '203.0.113.95');
  const ev = (await c.next('welcome')).events[0];
  assert.equal(ev.full, false);
  assert.equal(ev.ct, undefined);
  assert.equal(ev.pct, 'preview');
});

test('a client that closes cleanly before its receipt no longer holds the full', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.96');
  const b = await joinFrom(url, id, 'linus-client', '203.0.113.97');
  await a.next('welcome');
  await b.next('welcome');
  await addImage(url, id, 'ada-client');
  await b.next('events');
  b.ws.close(1001); // the tab went away
  await a.next('usage');
  assert.equal(app.store.get(id).events[0].ct, undefined);
});

test('a client that closes without a code (1005: on purpose, not a drop) no longer holds the full', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.106');
  const b = await joinFrom(url, id, 'linus-client', '203.0.113.107');
  await a.next('welcome');
  await b.next('welcome');
  await addImage(url, id, 'ada-client');
  await b.next('events');
  b.ws.close(); // a close frame without a code
  await a.next('usage');
  assert.equal(app.store.get(id).events[0].ct, undefined);
});

test('a client whose connection drops abnormally still holds the full, and confirms it when back', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.98');
  const b = await joinFrom(url, id, 'linus-client', '203.0.113.99');
  await a.next('welcome');
  await b.next('welcome');
  assert.equal((await a.next('presence')).present, 2);
  const { data } = await addImage(url, id, 'ada-client');
  b.ws.terminate(); // a network drop: no close frame, the server sees 1006
  assert.equal((await a.next('presence')).present, 1);
  assert.equal(app.store.get(id).events[0].ct, 'full');
  const back = await joinFrom(url, id, 'linus-client', '203.0.113.99');
  const ev = (await back.next('welcome')).events[0];
  assert.equal(ev.full, true);
  assert.equal(ev.ct, 'full');
  back.ws.send(gotMsg(data.seq));
  await a.next('usage');
  assert.equal(app.store.get(id).events[0].ct, undefined);
});

test('a client with two connections still holds the full while one of them is open', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.100');
  const b1 = await joinFrom(url, id, 'linus-client', '203.0.113.101');
  const b2 = await joinFrom(url, id, 'linus-client', '203.0.113.101');
  for (const c of [a, b1, b2]) await c.next('welcome');
  await addImage(url, id, 'ada-client');
  b1.ws.close(1000);
  await waitFor(() => app.liveStats().open === 2);
  assert.equal(app.store.get(id).events[0].ct, 'full');
  b2.ws.close(1000);
  await a.next('usage');
  assert.equal(app.store.get(id).events[0].ct, undefined);
});

test('messages after hello that are not a valid receipt are ignored without closing the socket', async () => {
  const { url, app } = await server();
  const id = await createSession(url);
  const a = await joinFrom(url, id, 'ada-client', '203.0.113.102');
  const b = await joinFrom(url, id, 'linus-client', '203.0.113.103');
  await a.next('welcome');
  await b.next('welcome');
  const { data } = await addImage(url, id, 'ada-client');
  for (const msg of ['garbage', 'null', '[]', '{}', JSON.stringify({ type: 'got' }), gotMsg(-1), gotMsg(1.5), gotMsg(String(data.seq)),
    gotMsg(Number.MAX_SAFE_INTEGER + 2), JSON.stringify({ type: 'hello', id, auth: AUTH, client: 'linus-client', since: -1 })]) {
    b.ws.send(msg);
  }
  b.ws.send(Buffer.from(gotMsg(data.seq)), { binary: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.ws.readyState, WsClient.OPEN);
  assert.equal(app.store.get(id).events[0].ct, 'full');
  b.ws.send(gotMsg(data.seq)); // the socket still takes a valid receipt
  await a.next('usage');
  assert.equal(app.store.get(id).events[0].ct, undefined);
});

test('the welcome budget counts previews before any welcome is built', async (t) => {
  const { url, app } = await server({ maxSessionBytes: 30_000_000, maxTotalBytes: 1e9, maxPreviewBytes: 1_500_000, maxWelcomeBytesInFlight: 1 });
  const id = await createSession(url);
  const pct = randomBytes(1_120_000).toString('base64url');
  for (let i = 0; i < 19; i++) assert.equal((await addImage(url, id, 'creator-0', { pct })).status, 200); // big previews, tiny fulls
  assert.equal(app.store.get(id).events[0].ct, 'full'); // held until the first other member has it
  const slow = wsFrom(url, { 'x-forwarded-for': '203.0.113.104' });
  assert.equal(await slow.opened, true);
  slow.ws.pause();
  slow.hello(id, 'ada-client');
  await waitFor(() => app.liveStats().open === 1);
  const encodes = t.mock.method(JSON, 'stringify');
  const second = await joinFrom(url, id, 'linus-client', '203.0.113.105');
  assert.equal((await second.next('error')).code, 'RATE_LIMITED');
  assert.equal(encodes.mock.calls.filter((c) => c.arguments[0]?.type === 'welcome').length, 0, 'refused before its welcome is built');
  encodes.mock.restore();
  slow.ws.resume();
  await slow.next('welcome', 10000);
});
