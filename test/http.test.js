// Tests for the HTTP layer: static files, security headers and the JSON API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, post } from './helpers.js';
import { hashAuth } from '../src/store.js';
import { loadConfig } from '../src/config.js';

const root = mkdtempSync(join(tmpdir(), 'pastepage-'));
const publicDir = join(root, 'public');
mkdirSync(publicDir);
writeFileSync(join(root, 'secret.txt'), 'SENTINEL-OUTSIDE');
symlinkSync(join(root, 'secret.txt'), join(publicDir, 'link.txt'));
symlinkSync(root, join(publicDir, 'up'));
writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>PastePage</title>');
writeFileSync(join(publicDir, 'a.js'), 'console.log(1);');
after(() => rmSync(root, { recursive: true, force: true }));

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const AUTH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const CLIENT = 'client-ada';
const IV = 'A'.repeat(16);
let counter = 0;
const newId = () => `${String(10 + counter++).padStart(2, '0')}-red-fox`;

async function server(overrides, opts) {
  const s = await start(overrides, { publicDir, ...opts });
  after(() => s.app.close());
  return s;
}

/** Raw GET that keeps the path exactly as given. */
function raw(base, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: base.hostname, port: base.port, path }, (r) => {
      let text = '';
      r.on('data', (d) => { text += d; });
      r.on('end', () => resolve({ status: r.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

function checkHeaders(res) {
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
}

async function make(url, extra = {}) {
  const id = newId();
  const r = await post(url, 'create', { id, auth: AUTH, client: CLIENT, ...extra });
  assert.equal(r.status, 200);
  return id;
}

test('static index with headers', async () => {
  const { url } = await server();
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  checkHeaders(res);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(await res.text(), /PastePage/);
  const js = await fetch(`${url}a.js?x=1`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  checkHeaders(head);
});

test('static safety', async () => {
  const { url } = await server();
  const base = new URL(url);
  for (const path of ['/missing.js', '/%zz', '/a.js%00']) {
    const res = await fetch(new URL(path, base));
    assert.equal(res.status, 404, path);
    checkHeaders(res);
  }
  // raw requests so the client cannot normalise the path; the sentinel sits beside publicDir
  const rawPaths = ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/..%2fsecret.txt', '/%252e%252e/secret.txt', '/link.txt', '/up/secret.txt', '/up/'];
  for (const path of rawPaths) {
    const { status, text } = await raw(base, path);
    assert.equal(status, 404, path);
    assert.ok(!text.includes('SENTINEL-OUTSIDE'), path);
  }
  const post404 = await fetch(`${url}a.js`, { method: 'POST' });
  assert.equal(post404.status, 405);
  checkHeaders(post404);
});

test('create', async () => {
  const { url } = await server();
  const id = newId();
  const a = await post(url, 'create', { id, auth: AUTH, client: CLIENT, hours: 1 });
  assert.equal(a.status, 200);
  assert.equal(typeof a.data.expires, 'number');
  assert.equal(typeof a.data.now, 'number');
  assert.deepEqual(Object.keys(a.data).sort(), ['expires', 'now']);
  const b = await post(url, 'create', { id, auth: AUTH, client: CLIENT });
  assert.equal(b.status, 409);
  assert.deepEqual(b.data, { error: 'TAKEN' });
});

test('hours is clamped by the store, not rejected', async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const { url } = await server();
  const near = (got, hours) => assert.ok(Math.abs(got - (t0 + hours * 3600)) <= 5, `${got} vs ${hours}h`);
  const lo = await post(url, 'create', { id: newId(), auth: AUTH, client: CLIENT, hours: 0 });
  assert.equal(lo.status, 200);
  near(lo.data.expires, 1);
  near((await post(url, 'create', { id: newId(), auth: AUTH, client: CLIENT, hours: 500 })).data.expires, 168);
  near((await post(url, 'create', { id: newId(), auth: AUTH, client: CLIENT, hours: -3 })).data.expires, 1);
  near((await post(url, 'create', { id: newId(), auth: AUTH, client: CLIENT })).data.expires, 24);
  const id = await make(url);
  near((await post(url, 'expire', { id, auth: AUTH, client: CLIENT, hours: 500 })).data.expires, 168);
});

test('create counts TAKEN against the failure limiter', async () => {
  const { url } = await server({ trustProxy: 'loopback' });
  const id = await make(url);
  const from = (ip) => ({ 'x-forwarded-for': ip });
  const body = { id, auth: AUTH, client: CLIENT };
  for (let i = 0; i < 10; i++) {
    const r = await post(url, 'create', body, from('203.0.113.9'));
    assert.deepEqual([r.status, r.data], [409, { error: 'TAKEN' }]);
  }
  const locked = await post(url, 'create', body, from('203.0.113.9'));
  assert.deepEqual([locked.status, locked.data], [429, { error: 'LOCKED' }]);
  const fresh = await post(url, 'create', { ...body, id: newId() }, from('203.0.113.9'));
  assert.deepEqual([fresh.status, fresh.data], [429, { error: 'LOCKED' }]);
  const other = await post(url, 'create', { ...body, id: newId() }, from('203.0.113.10'));
  assert.equal(other.status, 200);
});

test('unknown session and wrong token look the same', async () => {
  const { url } = await server();
  const id = await make(url);
  const base = { kind: 'note', iv: IV, ct: 'abc', client: CLIENT };
  const a = await post(url, 'add', { ...base, id: '99-no-such', auth: AUTH });
  const b = await post(url, 'add', { ...base, id, auth: OTHER });
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(a.data, { error: 'NOT_FOUND' });
  assert.deepEqual(b.data, a.data);
});

test('lockout per IP', async () => {
  const { url } = await server({ trustProxy: 'loopback' });
  const id = await make(url);
  const body = { id, auth: AUTH, client: CLIENT, kind: 'note', iv: IV, ct: 'abc' };
  const from = (ip) => ({ 'x-forwarded-for': ip });
  for (let i = 0; i < 10; i++) {
    const r = await post(url, 'add', { ...body, auth: OTHER }, from('203.0.113.1'));
    assert.equal(r.status, 404);
  }
  const locked = await post(url, 'add', body, from('203.0.113.1'));
  assert.equal(locked.status, 429);
  assert.deepEqual(locked.data, { error: 'LOCKED' });
  const other = await post(url, 'add', body, from('203.0.113.2'));
  assert.equal(other.status, 200);
});

test('IPv6 addresses in one /64 share the lockout and the create limit; other /64s do not', async () => {
  const { url } = await server({ maxFails: 3, createPerHour: 2 });
  const id = await make(url);
  const from = (ip) => ({ 'x-forwarded-for': ip });
  const body = { id, auth: OTHER, client: CLIENT, kind: 'note', iv: IV, ct: 'abc' };
  for (let i = 1; i <= 3; i++) {
    const r = await post(url, 'add', body, from(`2001:db8:0:1::${i}`)); // a different address in the same /64 each time
    assert.equal(r.status, 404);
  }
  const locked = await post(url, 'add', { ...body, auth: AUTH }, from('2001:db8:0:1:abcd::9'));
  assert.deepEqual([locked.status, locked.data], [429, { error: 'LOCKED' }]);
  const other = await post(url, 'add', { ...body, auth: AUTH }, from('2001:db8:0:2::1'));
  assert.equal(other.status, 200);

  const create = (ip) => post(url, 'create', { id: newId(), auth: AUTH, client: CLIENT }, from(ip));
  assert.equal((await create('2001:db8:0:3::1')).status, 200);
  assert.equal((await create('2001:db8:0:3::2')).status, 200);
  assert.deepEqual((await create('2001:db8:0:3::3')).data, { error: 'RATE_LIMITED' });
  assert.equal((await create('2001:db8:0:4::1')).status, 200);
});

test('create rate limit', async () => {
  const { url } = await server({ createPerHour: 2 });
  await make(url);
  await make(url);
  const r = await post(url, 'create', { id: newId(), auth: AUTH, client: CLIENT });
  assert.equal(r.status, 429);
  assert.deepEqual(r.data, { error: 'RATE_LIMITED' });
});

test('actions', async () => {
  const { url } = await server();
  const id = await make(url);
  const c = { id, auth: AUTH, client: CLIENT };
  const add = await post(url, 'add', { ...c, kind: 'note', iv: IV, ct: 'abc' });
  assert.deepEqual(add, { status: 200, data: { seq: 1 } });
  assert.deepEqual(await post(url, 'delete', { ...c, target: 1 }), { status: 200, data: { ok: true } });
  assert.deepEqual(await post(url, 'clear', c), { status: 200, data: { ok: true } });
  const exp = await post(url, 'expire', { ...c, hours: 1 });
  assert.equal(exp.status, 200);
  assert.deepEqual(Object.keys(exp.data), ['expires']);
  assert.equal(typeof exp.data.expires, 'number');
  assert.deepEqual(await post(url, 'end', c), { status: 200, data: { ok: true } });
  const after = await post(url, 'add', { ...c, kind: 'note', iv: IV, ct: 'abc' });
  assert.equal(after.status, 404);
});

test('add an image: the preview is required, and only images carry one', async () => {
  const { url } = await server();
  const id = await make(url);
  const c = { id, auth: AUTH, client: CLIENT };
  const image = { ...c, kind: 'image', iv: IV, ct: 'full', piv: IV, pct: 'preview' };
  assert.deepEqual(await post(url, 'add', image), { status: 200, data: { seq: 1 } });
  const bad = async (body) => {
    const r = await post(url, 'add', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.data, { error: 'BAD_REQUEST' });
  };
  await bad({ ...image, pct: undefined });
  await bad({ ...image, piv: undefined });
  await bad({ ...image, piv: 'short' });
  await bad({ ...image, pct: '' });
  await bad({ ...image, pct: 'not base64url!' });
  await bad({ ...c, kind: 'note', iv: IV, ct: 'abc', pct: 'preview' });
  await bad({ ...c, kind: 'note', iv: IV, ct: 'abc', piv: IV });
  await bad({ ...c, kind: 'burn', iv: IV, ct: 'abc', piv: IV, pct: 'preview' });
});

test('the largest image and preview fit in one request', async () => {
  const { url } = await server();
  const id = await make(url);
  const { maxNoteBytes, maxPreviewBytes } = loadConfig({});
  const r = await post(url, 'add', { id, auth: AUTH, client: CLIENT, kind: 'image', iv: IV, ct: 'x'.repeat(maxNoteBytes), piv: IV, pct: 'y'.repeat(maxPreviewBytes) });
  assert.deepEqual(r, { status: 200, data: { seq: 1 } });
});

test('burn-open', async () => {
  const { url } = await server();
  const id = await make(url);
  const c = { id, auth: AUTH, client: CLIENT };
  const add = await post(url, 'add', { ...c, kind: 'burn', iv: IV, ct: 'secret' });
  assert.equal(add.data.seq, 1);
  const own = await post(url, 'burn-open', { ...c, target: 1 });
  assert.equal(own.status, 403);
  assert.deepEqual(own.data, { error: 'FORBIDDEN' });
  const ok = await post(url, 'burn-open', { ...c, client: 'client-linus', target: 1 });
  assert.deepEqual(ok, { status: 200, data: { iv: IV, ct: 'secret' } });
  const again = await post(url, 'burn-open', { ...c, client: 'client-linus', target: 1 });
  assert.equal(again.status, 410);
  assert.deepEqual(again.data, { error: 'GONE' });
});

test('bad input', async () => {
  const { url } = await server();
  const id = await make(url);
  const c = { id, auth: AUTH, client: CLIENT };
  const add = { ...c, kind: 'note', iv: IV, ct: 'abc' };
  const bad = async (action, body) => {
    const r = await post(url, action, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.data, { error: 'BAD_REQUEST' });
  };
  await bad('add', '{not json');
  await bad('add', '[]');
  await bad('add', 'null');
  await bad('add', { ...add, id: 'x' });
  await bad('add', { ...add, auth: 'zz' });
  await bad('add', { ...add, client: undefined });
  await bad('add', { ...add, client: 'a b' });
  await bad('add', { ...add, kind: 'delete' });
  await bad('add', { ...add, iv: 'short' });
  await bad('add', { ...add, ct: 'not base64url!' });
  await bad('add', { ...add, ct: '' });
  await bad('delete', { ...c, target: '1' });
  await bad('delete', { ...c, target: -1 });
  await bad('delete', { ...c, target: 1.5 });
  await bad('burn-open', { ...c });
  for (const hours of [1.5, '24', null, 'x']) {
    await bad('create', { ...c, id: newId(), hours });
    await bad('expire', { ...c, hours });
  }
  await bad('expire', c);
  await bad('nonsense', c);
  const get = await fetch(`${url}api/add`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.deepEqual(await get.json(), { error: 'METHOD' });
  checkHeaders(get);
});

test('oversized body gets a reliable 413 (declared length)', async () => {
  const { url } = await server();
  const { maxNoteBytes, maxPreviewBytes } = loadConfig({});
  const big = 'x'.repeat(maxNoteBytes + maxPreviewBytes + 20000);
  for (let i = 0; i < 5; i++) {
    const r = await post(url, 'add', big);
    assert.equal(r.status, 413, `run ${i}`);
    assert.deepEqual(r.data, { error: 'TOO_LARGE' });
  }
});

/** Chunked upload (no Content-Length) of `total` bytes; rejects on any socket error. */
function chunkedUpload(base, total) {
  return new Promise((resolve, reject) => {
    const req = request({ host: base.hostname, port: base.port, method: 'POST', path: '/api/add' }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    const chunk = Buffer.alloc(65536, 120);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) return req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

test('oversized chunked body gets a reliable 413', async () => {
  const { url } = await server();
  const base = new URL(url);
  for (let i = 0; i < 5; i++) {
    const r = await chunkedUpload(base, 2 * 1024 * 1024);
    assert.equal(r.status, 413, `run ${i}`);
    assert.deepEqual(JSON.parse(r.text), { error: 'TOO_LARGE' });
  }
});

test('a client that aborts mid-upload is dropped without logging', async (t) => {
  const { url } = await server();
  const base = new URL(url);
  const spy = t.mock.method(console, 'error', () => {});
  await new Promise((resolve) => {
    const req = request({ host: base.hostname, port: base.port, method: 'POST', path: '/api/add', headers: { 'content-length': '100000' } });
    req.on('error', () => {});
    req.on('close', resolve);
    req.write(Buffer.alloc(20000, 120), () => setTimeout(() => req.destroy(), 20));
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(spy.mock.callCount(), 0);
});

test('api responses are no-store with security headers', async () => {
  const { url } = await server();
  const id = await make(url);
  const cases = [
    { id: 'x', auth: AUTH, client: CLIENT },
    { id, auth: OTHER, client: CLIENT },
    { id, auth: AUTH, client: CLIENT },
  ];
  for (const body of cases) {
    const res = await fetch(`${url}api/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.notEqual(res.status, 415);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    checkHeaders(res);
    await res.arrayBuffer();
  }
});

/** POST a JSON body as the given content type (none when null), with extra headers. */
async function postAs(url, action, body, contentType, headers = {}) {
  const res = await fetch(`${url}api/${action}`, {
    method: 'POST',
    headers: { ...(contentType === null ? {} : { 'content-type': contentType }), ...headers },
    body: new TextEncoder().encode(JSON.stringify(body)), // bytes: fetch adds no content type of its own
  });
  return { status: res.status, data: await res.json(), res };
}

test('the API only accepts JSON, and refused requests do not count toward the lockout', async () => {
  const { url, app } = await server({ maxFails: 3 });
  const id = await make(url);
  const wrong = { id, auth: OTHER, client: CLIENT, kind: 'note', iv: IV, ct: 'abc' };
  for (const type of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null, 'application/jsonp', 'text/json']) {
    for (let i = 0; i < 4; i++) {
      const r = await postAs(url, 'add', wrong, type);
      assert.deepEqual([r.status, r.data], [415, { error: 'BAD_REQUEST' }], String(type));
      checkHeaders(r.res);
    }
  }
  assert.equal(app.failures.size, 0);
  const ok = { ...wrong, auth: AUTH };
  for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON ; charset=UTF-8']) {
    assert.equal((await postAs(url, 'add', ok, type)).status, 200, type);
  }
  assert.equal((await postAs(url, 'add', wrong, 'application/json')).status, 404);
  assert.equal(app.failures.size, 1, 'a JSON request with a wrong password still counts');
});

test('API requests the browser marks as cross-site or same-site are refused and not counted', async () => {
  const { url, app } = await server({ maxFails: 3 });
  const id = await make(url);
  const wrong = { id, auth: OTHER, client: CLIENT, kind: 'note', iv: IV, ct: 'abc' };
  for (const site of ['cross-site', 'same-site']) {
    for (let i = 0; i < 4; i++) {
      const r = await postAs(url, 'add', wrong, 'application/json', { 'sec-fetch-site': site });
      assert.deepEqual([r.status, r.data], [403, { error: 'FORBIDDEN' }], site);
      checkHeaders(r.res);
    }
    const create = await postAs(url, 'create', { id: newId(), auth: AUTH, client: CLIENT }, 'application/json', { 'sec-fetch-site': site });
    assert.equal(create.status, 403);
  }
  assert.equal(app.failures.size, 0);
  for (const site of ['same-origin', 'none']) {
    const r = await postAs(url, 'add', { ...wrong, auth: AUTH }, 'application/json', { 'sec-fetch-site': site });
    assert.equal(r.status, 200, site);
  }
  assert.equal((await postAs(url, 'add', wrong, 'application/json', { 'sec-fetch-site': 'same-origin' })).status, 404);
  assert.equal(app.failures.size, 1);
});

test('stored token is hashed, session is not serialised', async () => {
  const { url, app } = await server();
  const id = await make(url);
  assert.equal(app.store.get(id).authHash, hashAuth(AUTH));
});

test('unexpected errors give INTERNAL without leaking', async (t) => {
  const { url, app } = await server();
  const id = await make(url);
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
  t.mock.method(app.store, 'clear', () => { throw new Error('boom secret-detail'); });
  const r = await post(url, 'clear', { id, auth: AUTH, client: CLIENT });
  assert.equal(r.status, 500);
  assert.deepEqual(r.data, { error: 'INTERNAL' });
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(AUTH));
});
