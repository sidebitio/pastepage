// HTTP layer: static files from public/ and the JSON API under /api/*, all with strict security headers.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { AppError, ERRORS } from './errors.js';
import { clientIp, limitKey } from './clientip.js';
import { hashAuth } from './store.js';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const RE = {
  id: /^[0-9]{2}-[a-z]{2,20}-[a-z]{2,20}$/,
  auth: /^[0-9a-f]{64}$/,
  client: /^[A-Za-z0-9_-]{6,32}$/,
  iv: /^[A-Za-z0-9_-]{16}$/,
  ct: /^[A-Za-z0-9_-]+$/,
};
const KINDS = new Set(['note', 'burn', 'meta']);
const ACTIONS = new Set(['create', 'add', 'delete', 'clear', 'expire', 'end', 'burn-open']);
const OTHER_SITE = new Set(['cross-site', 'same-site']);

/**
 * Whether the browser marked a request as coming from another website (`Sec-Fetch-Site: cross-site` or `same-site`).
 * Requests without the header (non-browser clients, and browsers that don't send it) are not counted as such.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function fromOtherSite(req) {
  return OTHER_SITE.has(String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase());
}

/** Whether the request body is declared as JSON (`Content-Type: application/json`, parameters such as charset ignored). */
const isJson = (req) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';

/** Send a complete response with the security headers added. */
function send(res, status, headers, body) {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

/** Send a JSON API response (never cached). */
function sendJson(res, status, data, extra = {}) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }, JSON.stringify(data));
}

function sendError(res, code, extra) {
  sendJson(res, ERRORS[code], { error: code }, extra);
}

const DRAIN_BYTES = 16 * 1024 * 1024;
const DRAIN_MS = 10_000;

/** The client went away (or the socket failed) while the body was being read; not worth logging. */
class ClientGone extends Error {}

/**
 * Read a request body up to a byte cap, without buffering more than the cap.
 * Past the cap the rest is read and discarded (so the socket is never closed with unread upload data,
 * which would let an RST wipe out our 413), up to a drain budget of 16 MiB or 10 seconds.
 * @returns {Promise<{body: Buffer}|{tooLarge: true, abusive: boolean}>} abusive means the drain budget ran out first
 */
function readBody(req, cap) {
  return new Promise((resolveBody, reject) => {
    req.on('error', () => {}); // an abort after we stop listening must not become an unhandled error
    const chunks = [];
    let size = 0;
    let draining = false;
    let drained = 0;
    let timer;
    const declared = Number(req.headers['content-length']);
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('close', onClose);
    };
    const finish = (result) => { cleanup(); resolveBody(result); };
    const startDrain = () => {
      draining = true;
      chunks.length = 0;
      timer = setTimeout(() => finish({ tooLarge: true, abusive: true }), DRAIN_MS);
      timer.unref();
    };
    const onData = (chunk) => {
      if (draining) {
        drained += chunk.length;
        if (drained > DRAIN_BYTES) finish({ tooLarge: true, abusive: true });
        return;
      }
      size += chunk.length;
      if (size > cap) return startDrain();
      chunks.push(chunk);
    };
    const onEnd = () => finish(draining ? { tooLarge: true, abusive: false } : { body: Buffer.concat(chunks) });
    const onGone = () => { cleanup(); reject(new ClientGone()); };
    const onClose = () => { if (!req.complete) onGone(); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onGone);
    req.on('close', onClose);
    if (Number.isFinite(declared) && declared > cap) startDrain();
  });
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = () => new AppError('BAD_REQUEST');

/**
 * Validate a parsed request body for an action.
 * @returns {object} the validated fields
 * @throws {AppError} BAD_REQUEST
 */
function validate(action, body) {
  if (!ACTIONS.has(action) || !isObject(body)) throw bad();
  const str = (name) => {
    if (typeof body[name] !== 'string' || !RE[name].test(body[name])) throw bad();
    return body[name];
  };
  const out = { id: str('id'), auth: str('auth'), client: str('client') };
  // hours: any safe integer is accepted; the store clamps it to 1..maxHours. Required for expire.
  if (body.hours !== undefined || action === 'expire') {
    if (!Number.isSafeInteger(body.hours)) throw bad();
    out.hours = body.hours;
  }
  if (action === 'add') {
    if (typeof body.kind !== 'string' || !KINDS.has(body.kind)) throw bad();
    out.kind = body.kind;
    out.iv = str('iv');
    out.ct = str('ct');
  }
  if (action === 'delete' || action === 'burn-open') {
    if (!Number.isSafeInteger(body.target) || body.target < 0) throw bad();
    out.target = body.target;
  }
  return out;
}

/**
 * Create the request handler.
 * @param {{config: object, store: object, failures: object, creates: object, isTrusted: (addr: string) => boolean, publicDir: string, now?: () => number}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createHttpHandler({ config, store, failures, creates, isTrusted, publicDir, now = () => Date.now() }) {
  const bodyCap = config.maxNoteBytes + 16384;

  async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
    }
    const notFound = () => send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, 'Not Found');
    let pathname;
    try {
      pathname = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
    } catch {
      return notFound();
    }
    if (pathname.includes('\0')) return notFound();
    if (pathname.endsWith('/')) pathname += 'index.html';
    let file;
    try {
      const root = await realpath(publicDir);
      file = await realpath(resolve(root, '.' + (pathname.startsWith('/') ? pathname : '/' + pathname)));
      if (!file.startsWith(root + sep)) return notFound();
      if (!(await stat(file)).isFile()) return notFound();
    } catch {
      return notFound();
    }
    let data;
    try {
      data = await readFile(file);
    } catch {
      return notFound();
    }
    const headers = {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    };
    send(res, 200, headers, req.method === 'HEAD' ? undefined : data);
  }

  /**
   * Run one validated API action. Synchronous after the auth check, so the session cannot end in between.
   * ip is the limitKey of the client's address: what the lockout and the create limit count under.
   */
  function run(action, f, ip, res) {
    if (action === 'create') {
      if (failures.isLocked(ip)) throw new AppError('LOCKED');
      if (!creates.allow(ip)) throw new AppError('RATE_LIMITED');
      let session;
      try {
        session = store.create({ id: f.id, authHash: hashAuth(f.auth), hours: f.hours });
      } catch (err) {
        if (err instanceof AppError && err.code === 'TAKEN') failures.fail(ip); // creating must not reveal ids for free
        throw err;
      }
      return sendJson(res, 200, { expires: session.expires, now: Math.floor(now() / 1000) });
    }
    if (failures.isLocked(ip)) throw new AppError('LOCKED');
    const session = store.check(f.id, hashAuth(f.auth));
    if (!session) {
      failures.fail(ip);
      throw new AppError('NOT_FOUND');
    }
    switch (action) {
      case 'add':
        return sendJson(res, 200, { seq: store.append(session, { kind: f.kind, client: f.client, iv: f.iv, ct: f.ct }).seq });
      case 'delete':
        store.deleteNote(session, f.target);
        return sendJson(res, 200, { ok: true });
      case 'clear':
        store.clear(session);
        return sendJson(res, 200, { ok: true });
      case 'expire':
        return sendJson(res, 200, { expires: store.setExpiry(session, f.hours) });
      case 'end':
        store.end(f.id, 'ended');
        return sendJson(res, 200, { ok: true });
      default: {
        const { iv, ct } = store.burnOpen(session, f.target, f.client);
        return sendJson(res, 200, { iv, ct });
      }
    }
  }

  async function serveApi(req, res, action) {
    if (req.method !== 'POST') return sendError(res, 'METHOD', { Allow: 'POST' });
    const read = await readBody(req, bodyCap);
    if (read.tooLarge) {
      if (!read.abusive) return sendError(res, 'TOO_LARGE');
      // Drain budget exhausted: answer, then drop the socket. Losing this response is acceptable.
      sendError(res, 'TOO_LARGE', { Connection: 'close' });
      res.once('finish', () => req.socket.destroy());
      return;
    }
    // Requests another website can make the visitor's browser send are refused before anything counts toward the
    // lockout. Only JSON is accepted: a browser asks first (a CORS preflight) before sending JSON to another site,
    // and PastePage never says yes.
    if (fromOtherSite(req)) return sendError(res, 'FORBIDDEN');
    if (!isJson(req)) return sendJson(res, 415, { error: 'BAD_REQUEST' });
    const raw = read.body;
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw bad();
    }
    const fields = validate(action, body);
    run(action, fields, limitKey(clientIp(req, isTrusted)), res); // the limits count IPv6 addresses by their /64
  }

  async function handle(req, res) {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname.startsWith('/api/')) return serveApi(req, res, pathname.slice(5));
    return serveStatic(req, res);
  }

  return (req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ClientGone || req.socket?.destroyed) return; // client aborted: drop quietly
      if (err instanceof AppError) return sendError(res, err.code);
      console.error(err?.stack ?? String(err));
      sendError(res, 'INTERNAL');
    });
  };
}
