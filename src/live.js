// Live updates: one WebSocket per open page at /ws, authenticated by a first "hello" message, never by the URL.
import { WebSocketServer } from 'ws';
import { hashAuth } from './store.js';
import { clientIp, limitKey } from './clientip.js';
import { fromOtherSite } from './http.js';

const ID_RE = /^[0-9]{2}-[a-z]{2,20}-[a-z]{2,20}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{6,32}$/;

/**
 * Serialise a message once, as UTF-8 bytes. One Buffer can go to many sockets without a copy per socket
 * (a string would be copied for every socket it is written to).
 */
const encode = (message) => Buffer.from(JSON.stringify(message));

/** Close a socket with a code; never throws. */
function closeSocket(ws, code) {
  try {
    ws.close(code);
  } catch (err) {
    console.error(err.stack);
  }
}

/** Refuse a WebSocket upgrade with an HTTP status, before any WebSocket exists. */
function refuseUpgrade(socket, status, reason) {
  socket.once('finish', () => socket.destroy());
  socket.once('error', () => {});
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const decrement = (map, key) => {
  const n = (map.get(key) ?? 0) - 1;
  if (n > 0) map.set(key, n); else map.delete(key);
};

/**
 * Limits derived from the config, once. Both are at least the largest welcome a session can need: the session's
 * stored bytes (MAX_SESSION_BYTES) plus at most 256 bytes of JSON per event it can hold (a session holds at most
 * twice MAX_EVENTS events, each with at most 127 bytes of JSON beyond what its stored bytes count), plus 1 MiB to spare.
 * @param {{maxSessionBytes: number, maxEvents: number, maxBufferedBytes: number, maxWelcomeBytesInFlight: number}} config
 * @returns {{sendBacklog: number, welcomeBudget: number}} sendBacklog: bytes that may wait for one socket before it
 *   is cut off; welcomeBudget: bytes of welcomes that may wait to be sent, all sockets together
 */
export function liveLimits(config) {
  const largestWelcome = config.maxSessionBytes + config.maxEvents * 256 + 1024 * 1024;
  return {
    sendBacklog: Math.max(config.maxBufferedBytes, largestWelcome),
    welcomeBudget: Math.max(config.maxWelcomeBytesInFlight, largestWelcome),
  };
}

/**
 * Attach the WebSocket endpoint (/ws) to an HTTP server and wire it to the session store.
 * @param {import('node:http').Server} server the HTTP server to handle upgrades on
 * @param {{store: import('./store.js').SessionStore, failures: import('./limits.js').FailureLimiter, isTrusted: (addr: string) => boolean,
 *   config: {helloTimeoutMs: number, pingMs: number, maxSocketsPerIp: number, maxSocketsPerSession: number,
 *   maxSocketsTotal: number, maxPendingPerIp: number, maxPendingTotal: number, maxBufferedBytes: number,
 *   maxWelcomeBytesInFlight: number, maxSessionBytes: number, maxEvents: number}}} deps
 * @returns {{close: () => Promise<void>, stats: () => {open: number, pending: number, welcomeBytes: number}}} close
 *   stops the heartbeat and closes every socket; stats gives, for the whole server, the number of open (said hello)
 *   and pending (not yet) sockets, and the bytes of welcomes that are not yet passed on to the network
 */
export function attachLive(server, { store, failures, isTrusted, config }) {
  // closeTimeout: ws waits this long for the peer to answer our close frame, then destroys the socket
  // (default 30 s). A pending slot is released only when the socket closes, so keep it short.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, closeTimeout: 2000 });
  /** sessionId -> Map<clientId, Set<ws>> */
  const rooms = new Map();
  const alive = new WeakSet();
  /** limitKey(IP) -> number of sockets that said a valid hello and are open. */
  const openPerIp = new Map();
  /** limitKey(IP) -> number of sockets that have not sent their first message yet. */
  const pendingPerIp = new Map();
  /** The same two counts for the whole server. */
  let openTotal = 0;
  let pendingTotal = 0;
  /** Bytes of welcomes handed to sockets that have not yet been passed on to the network. */
  let welcomeBytes = 0;
  const { sendBacklog, welcomeBudget } = liveLimits(config);

  const sockets = (id) => {
    const out = [];
    for (const set of rooms.get(id)?.values() ?? []) out.push(...set);
    return out;
  };

  /**
   * Send an encoded message if the socket is open; never throws. A socket that already has more than
   * sendBacklog bytes waiting (it stopped reading) is cut off instead of being given more.
   */
  function send(ws, data) {
    try {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > sendBacklog) {
        ws.terminate();
        return;
      }
      ws.send(data, { binary: false });
    } catch (err) {
      console.error(err.stack);
    }
  }

  /** Send one message to every socket of a session, serialised once. */
  function broadcast(id, message, except = null) {
    const list = sockets(id).filter((ws) => ws !== except);
    if (list.length === 0) return;
    const data = encode(message);
    for (const ws of list) send(ws, data);
  }

  /** Record the distinct-client count in the store; tolerates a session that is already gone. */
  function syncStore(id, count) {
    const session = store.get(id);
    if (session) store.setPresence(session, count);
  }

  function register(ws, id, client, ip) {
    let room = rooms.get(id);
    if (!room) rooms.set(id, (room = new Map()));
    const before = room.size;
    let set = room.get(client);
    if (!set) room.set(client, (set = new Set()));
    set.add(ws);
    increment(openPerIp, ip);
    openTotal++;
    ws.once('close', () => {
      decrement(openPerIp, ip);
      openTotal--;
      unregister(ws, id, client);
    });
    if (room.size !== before) {
      syncStore(id, room.size);
      broadcast(id, { type: 'presence', present: room.size }, ws);
    }
    return room.size;
  }

  function unregister(ws, id, client) {
    const room = rooms.get(id);
    const set = room?.get(client);
    if (!set || !set.delete(ws)) return;
    if (set.size > 0) return;
    room.delete(client);
    if (room.size === 0) rooms.delete(id);
    syncStore(id, room.size);
    broadcast(id, { type: 'presence', present: room.size });
  }

  function reject(ws, code) {
    send(ws, encode({ type: 'error', code }));
    closeSocket(ws, 4001);
  }

  /**
   * Send a welcome and count its bytes toward welcomeBytes until it has been passed on to the network (the send
   * callback), or the socket has closed, whichever comes first.
   */
  function sendWelcome(ws, data) {
    welcomeBytes += data.length;
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      welcomeBytes -= data.length;
    };
    ws.once('close', release);
    try {
      ws.send(data, { binary: false }, release);
    } catch (err) {
      release();
      console.error(err.stack);
    }
  }

  /** A new socket; notPending is called once it is no longer waiting for its first message. */
  function onConnection(ws, req, notPending = () => {}) {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => {});
    let seenFirst = false;
    const timer = setTimeout(() => {
      seenFirst = true; // the deadline passed: a late hello must not be accepted while the close is pending
      closeSocket(ws, 4001);
    }, config.helloTimeoutMs);
    ws.once('close', () => clearTimeout(timer));

    ws.on('message', (data, isBinary) => {
      if (seenFirst || ws.readyState !== ws.OPEN) return;
      seenFirst = true; // only the first message counts, valid or not
      clearTimeout(timer);
      notPending();
      let msg;
      try {
        if (isBinary) throw new Error('binary');
        msg = JSON.parse(data.toString());
      } catch {
        return reject(ws, 'BAD_REQUEST');
      }
      if (!msg || typeof msg !== 'object' || msg.type !== 'hello'
        || typeof msg.id !== 'string' || !ID_RE.test(msg.id)
        || typeof msg.auth !== 'string' || !TOKEN_RE.test(msg.auth)
        || typeof msg.client !== 'string' || !CLIENT_RE.test(msg.client)
        || !Number.isSafeInteger(msg.since) || msg.since < -1) {
        return reject(ws, 'BAD_REQUEST');
      }
      // Lockout check, auth, the connection limits and registration happen in this one tick.
      const ip = limitKey(clientIp(req, isTrusted)); // the limits count IPv6 addresses by their /64
      if (failures.isLocked(ip)) return reject(ws, 'LOCKED'); // a lock earned through the API applies here too
      const session = store.check(msg.id, hashAuth(msg.auth));
      // A failed hello is not counted toward the lockout. A page on another website can open live connections in
      // browsers that don't mark them (Chrome), and pages reconnecting after a restart all fail at once; counting
      // those locked out innocent visitors. Guessing gains little here: the page makes a random 14-character password
      // (about 69 bits) and every guess costs a 600,000-iteration PBKDF2. Failed API requests are still counted.
      if (!session) return reject(ws, 'NOT_FOUND');
      // Over a limit, the page is told RATE_LIMITED and tries again later, with its usual back-off.
      if ((openPerIp.get(ip) ?? 0) >= config.maxSocketsPerIp || sockets(msg.id).length >= config.maxSocketsPerSession
        || openTotal >= config.maxSocketsTotal) {
        return reject(ws, 'RATE_LIMITED');
      }
      // A welcome can be as large as the session. Pages that don't read would otherwise make the server hold one for
      // each of them, so the welcomes not yet passed on to the network share one budget. The ciphertexts appear in
      // the welcome as they are, so their length is a lower bound that refuses most pages before any JSON is built.
      const { mode, events } = store.eventsSince(session, msg.since);
      let atLeast = 0;
      for (const ev of events) atLeast += ev.ct?.length ?? 0;
      if (welcomeBytes + atLeast > welcomeBudget) return reject(ws, 'RATE_LIMITED');
      const room = rooms.get(msg.id);
      const welcome = encode({
        type: 'welcome',
        mode,
        events,
        expires: session.expires,
        present: (room?.size ?? 0) + (room?.has(msg.client) ? 0 : 1), // the count once this socket is registered
        now: Math.floor(store.now() / 1000),
      });
      if (welcomeBytes + welcome.length > welcomeBudget) return reject(ws, 'RATE_LIMITED');
      register(ws, msg.id, msg.client, ip);
      sendWelcome(ws, welcome);
    });
  }

  wss.on('connection', onConnection);

  const onUpgrade = (req, socket, head) => {
    let path = '';
    try {
      path = new URL(req.url, 'http://localhost').pathname;
    } catch { /* treated as a bad path */ }
    if (path !== '/ws') {
      socket.destroy();
      return;
    }
    // A page on another website has no business opening live connections (they would take up this visitor's
    // connection slots). This only works in browsers that send Sec-Fetch-Site on WebSocket handshakes; requests
    // without it are let through.
    if (fromOtherSite(req)) {
      refuseUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const ip = limitKey(clientIp(req, isTrusted));
    if ((pendingPerIp.get(ip) ?? 0) >= config.maxPendingPerIp || pendingTotal >= config.maxPendingTotal) {
      refuseUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    increment(pendingPerIp, ip);
    pendingTotal++;
    let pending = true;
    const notPending = () => {
      if (!pending) return;
      pending = false;
      decrement(pendingPerIp, ip);
      pendingTotal--;
    };
    socket.once('close', notPending);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, notPending));
  };
  server.on('upgrade', onUpgrade);

  const onEvent = (id, wire) => {
    try {
      broadcast(id, { type: 'events', events: [wire] });
    } catch (err) { console.error(err.stack); }
  };
  const onSession = (id, { expires }) => {
    try {
      broadcast(id, { type: 'session', expires });
    } catch (err) { console.error(err.stack); }
  };
  const onEnded = (id, reason) => {
    try {
      const list = sockets(id);
      rooms.delete(id);
      const data = encode({ type: 'ended', reason });
      for (const ws of list) {
        send(ws, data);
        closeSocket(ws, 4000);
      }
    } catch (err) { console.error(err.stack); }
  };
  store.on('event', onEvent);
  store.on('session', onSession);
  store.on('ended', onEnded);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, config.pingMs);
  heartbeat.unref();

  return {
    stats: () => ({ open: openTotal, pending: pendingTotal, welcomeBytes }),
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      store.off('event', onEvent);
      store.off('session', onSession);
      store.off('ended', onEnded);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
