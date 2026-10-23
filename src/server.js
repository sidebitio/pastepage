// Wires the store, limiters and HTTP handler into one server with listen/close.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHttpHandler } from './http.js';
import { SessionStore } from './store.js';
import { FailureLimiter, RateLimiter } from './limits.js';
import { parseTrustProxy } from './clientip.js';
import { attachLive } from './live.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

/**
 * Build a PastePage server (not yet listening).
 * @param {object} config resolved config from loadConfig
 * @param {{publicDir?: string, now?: () => number}} [opts] publicDir defaults to the repo's public/; now is a clock in ms
 * @returns {{server: import('node:http').Server, store: SessionStore, failures: FailureLimiter, creates: RateLimiter,
 *   liveStats: () => {open: number, pending: number, welcomeBytes: number}, listen: () => Promise<string>,
 *   close: () => Promise<void>}}
 *   liveStats counts the live connections (see attachLive)
 */
export function createPastePage(config, { publicDir = DEFAULT_PUBLIC_DIR, now = () => Date.now() } = {}) {
  const store = new SessionStore(config, now);
  const failures = new FailureLimiter({ maxFails: config.maxFails, windowSeconds: config.failWindowSeconds, lockSeconds: config.lockSeconds }, now);
  const creates = new RateLimiter({ limit: config.createPerHour, windowSeconds: 3600 }, now);
  const isTrusted = parseTrustProxy(config.trustProxy);
  const server = createServer(createHttpHandler({ config, store, failures, creates, isTrusted, publicDir, now }));
  const live = attachLive(server, { store, failures, isTrusted, config });

  let sweepTimer = null;

  /** Start listening on config.host and config.port and start the session sweep; resolves to the base URL with a trailing slash. */
  function listen() {
    return new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        sweepTimer = setInterval(() => store.sweep(), config.sweepMs);
        sweepTimer.unref();
        const { port } = server.address();
        const host = config.host.includes(':') ? `[${config.host}]` : config.host;
        resolveListen(`http://${host}:${port}/`);
      });
    });
  }

  /** Stop the sweep, stop accepting connections and close open ones, including WebSockets. */
  function close() {
    clearInterval(sweepTimer);
    const socketsClosed = live.close(); // closeAllConnections() does not destroy upgraded (WebSocket) sockets, so terminate them first via live.close()
    return new Promise((resolveClose) => {
      server.close(() => socketsClosed.then(resolveClose));
      server.closeAllConnections();
    });
  }

  return { server, store, failures, creates, liveStats: live.stats, listen, close };
}
