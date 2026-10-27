// Configuration: built-in defaults, environment variables and explicit arguments.

import { parseTrustProxy } from './clientip.js';

/** Default configuration values. */
export const DEFAULTS = Object.freeze({
  port: 3000,
  host: '127.0.0.1',
  trustProxy: 'loopback',
  idleSeconds: 120,
  maxHours: 168,
  defaultHours: 24,
  maxNoteBytes: 1500000,
  maxMetaBytes: 4096,
  maxPreviewBytes: 96000,
  maxSessionBytes: 12000000,
  maxEvents: 2000,
  maxSessions: 1000,
  maxTotalBytes: 268435456,
  maxFails: 10,
  failWindowSeconds: 900,
  lockSeconds: 900,
  createPerHour: 30,
  helloTimeoutMs: 5000,
  pingMs: 20000,
  sweepMs: 10000,
  // Live connections (not read from the environment): open sockets per IP address (IPv6: per /64), per session and
  // for the whole server; sockets that have not said hello yet, per IP address and for the whole server; how many
  // bytes may wait to be sent to one socket before it is cut off (raised to the largest welcome a session can need);
  // and how many bytes of welcomes may wait to be sent, all sockets together (never less than one largest welcome).
  maxSocketsPerIp: 20,
  maxSocketsPerSession: 50,
  maxSocketsTotal: 1000,
  maxPendingPerIp: 10,
  maxPendingTotal: 200,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxWelcomeBytesInFlight: 256 * 1024 * 1024,
});

// Config field -> environment variable. Fields not listed here are not read from the environment.
const ENV_NAMES = {
  port: 'PORT',
  host: 'HOST',
  trustProxy: 'TRUST_PROXY',
  idleSeconds: 'IDLE_SECONDS',
  maxHours: 'MAX_HOURS',
  maxNoteBytes: 'MAX_NOTE_BYTES',
  maxPreviewBytes: 'MAX_PREVIEW_BYTES',
  maxSessionBytes: 'MAX_SESSION_BYTES',
  maxEvents: 'MAX_EVENTS',
  maxSessions: 'MAX_SESSIONS',
  maxTotalBytes: 'MAX_TOTAL_BYTES',
  maxFails: 'MAX_FAILS',
  lockSeconds: 'LOCK_SECONDS',
  createPerHour: 'CREATE_PER_HOUR',
};

const STRING_FIELDS = new Set(['host', 'trustProxy']);

/**
 * Build the configuration. Precedence: args, then env, then DEFAULTS.
 * @param {Record<string, string|undefined>} [env] environment variables
 * @param {Record<string, string|number|undefined>} [args] overrides keyed by config field name
 * @returns {typeof DEFAULTS} the resolved config
 * @throws {Error} 'Invalid NAME: "value"' when a number is not a non-negative integer (MAX_HOURS: at least 1), or TRUST_PROXY is not understood
 */
export function loadConfig(env = process.env, args = {}) {
  const config = { ...DEFAULTS };
  for (const [field, name] of Object.entries(ENV_NAMES)) {
    const raw = args[field] ?? env[name];
    if (raw === undefined || raw === '') continue;
    if (STRING_FIELDS.has(field)) {
      config[field] = String(raw);
    } else {
      const text = String(raw).trim();
      if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(Number(text))) {
        throw new Error(`Invalid ${name}: "${raw}"`);
      }
      config[field] = Number(text);
      if (field === 'maxHours' && config[field] < 1) throw new Error(`Invalid ${name}: "${raw}"`);
    }
  }
  try {
    parseTrustProxy(config.trustProxy);
  } catch {
    throw new Error(`Invalid TRUST_PROXY: "${config.trustProxy}"`);
  }
  return config;
}
