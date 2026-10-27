// Browser network layer: JSON POSTs to api/<action> and one self-healing WebSocket to ws.
// DOM-free; runs in browsers and Node >= 22 (global fetch and WebSocket).

/**
 * POST a JSON body to an API action.
 * @param {string} action API action name, e.g. 'add'
 * @param {object} body JSON-serialisable request body
 * @param {string} [base] base URL ending in '/', or '' for the current page
 * @returns {Promise<{status: number, data: any}>} HTTP status (0 on network failure) and parsed body
 */
export async function api(action, body, base = '') {
  let res;
  try {
    res = await fetch(base + 'api/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { status: 0, data: { error: 'CONNECTION' } };
  }
  try {
    return { status: res.status, data: await res.json() };
  } catch {
    return { status: res.status, data: { error: 'INTERNAL' } };
  }
}

/** Build the WebSocket URL: the 'ws' endpoint next to the base, with no query or fragment. */
function socketUrl(base) {
  const u = new URL('ws', base || globalThis.location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = '';
  u.hash = '';
  return u.href;
}

/**
 * Keep a live WebSocket to the server. Authenticates with a hello message (never via the URL),
 * delivers pushed events and reconnects after drops, resuming from the last sequence number seen.
 * @param {object} opts
 * @param {string} [opts.base] base URL ending in '/', or '' for the current page
 * @param {() => {id: string, auth: string, client: string, since: number}} opts.hello hello fields, read on every connect
 * @param {(msg: object, info: {reset: boolean}) => void} [opts.onWelcome] welcome received; reset is true for a snapshot.
 *   msg is the server's welcome as it is, including share, used and rolled
 * @param {(events: object[]) => void} [opts.onEvents] new events pushed
 * @param {(used: number, rolled: number) => void} [opts.onUsage] the session's usage (0-1000) and rolled-off point
 *   (the highest seq dropped to make room, 0 when none), from the welcome, every events message and usage updates
 * @param {(present: number) => void} [opts.onPresence] presence count changed
 * @param {(expires: number) => void} [opts.onSession] session expiry changed
 * @param {(reason: string) => void} [opts.onEnded] session ended, expired or went idle
 * @param {(code: string) => void} [opts.onError] fatal error (NOT_FOUND, LOCKED, BAD_REQUEST); no reconnect
 * @param {(status: 'online'|'reconnecting'|'busy') => void} [opts.onStatus] connection status: 'busy' when the
 *   server turned the connection away because the session or server is at a limit (RATE_LIMITED), 'reconnecting'
 *   after any other drop; both are followed by a new attempt after the next delay
 * @param {number[]} [opts.delays] reconnect delays in ms; the last one repeats
 * @param {typeof WebSocket} [WebSocketImpl] WebSocket constructor
 * @returns {{close: () => void, send: (msg: object) => boolean}} handle; close() stops the connection for good (a clean
 *   leave, code 1000); send() sends a message as JSON on the current socket if it is open, and says whether it did
 */
export function connectLive(opts, WebSocketImpl = globalThis.WebSocket) {
  const delays = opts.delays?.length ? opts.delays : [1000, 2000, 5000, 10000];
  let lastSeq = typeof opts.hello().since === 'number' ? opts.hello().since : -1;
  let attempt = 0;
  let stopped = false;
  let ws = null;
  let timer = null;

  const maxSeq = (events) => {
    for (const e of events || []) if (typeof e?.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
  };

  function handle(msg) {
    switch (msg?.type) {
      case 'welcome': {
        const reset = msg.mode === 'snapshot';
        if (reset) lastSeq = -1;
        maxSeq(msg.events);
        attempt = 0;
        opts.onWelcome?.(msg, { reset });
        opts.onUsage?.(msg.used, msg.rolled);
        opts.onStatus?.('online');
        break;
      }
      case 'events':
        maxSeq(msg.events);
        opts.onEvents?.(msg.events);
        opts.onUsage?.(msg.used, msg.rolled);
        break;
      case 'usage':
        opts.onUsage?.(msg.used, msg.rolled);
        break;
      case 'presence':
        opts.onPresence?.(msg.present);
        break;
      case 'session':
        opts.onSession?.(msg.expires);
        break;
      case 'ended':
        stopped = true;
        opts.onEnded?.(msg.reason);
        break;
      case 'error':
        if (msg.code === 'NOT_FOUND' || msg.code === 'LOCKED' || msg.code === 'BAD_REQUEST') {
          stopped = true;
          opts.onError?.(msg.code);
        }
        break;
      default:
    }
  }

  function connect() {
    timer = null;
    if (stopped) return;
    const sock = new WebSocketImpl(socketUrl(opts.base));
    ws = sock;
    let busy = false; // this connection was turned away because a limit was reached
    sock.addEventListener('open', () => {
      sock.send(JSON.stringify({ ...opts.hello(), type: 'hello', since: lastSeq }));
    });
    sock.addEventListener('message', (ev) => {
      if (sock !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type === 'error' && msg.code === 'RATE_LIMITED') busy = true;
      handle(msg);
    });
    sock.addEventListener('close', () => {
      if (sock !== ws || stopped) return;
      opts.onStatus?.(busy ? 'busy' : 'reconnecting');
      timer = setTimeout(connect, delays[Math.min(attempt, delays.length - 1)]);
      attempt++;
    });
  }

  connect();

  return {
    close() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      try { ws?.close(1000); } catch { /* already closed */ }
    },
    send(msg) {
      if (stopped || ws?.readyState !== 1) return false; // 1: OPEN
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    },
  };
}
