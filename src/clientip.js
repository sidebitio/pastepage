// Client IP resolution behind a reverse proxy: trusted-proxy parsing and X-Forwarded-For handling.
import { isIP } from 'node:net';

/** Normalise an address: trim, and turn IPv4-mapped IPv6 (::ffff:1.2.3.4) into plain IPv4. Returns '' if invalid. */
function normalize(addr) {
  if (typeof addr !== 'string') return '';
  let a = addr.trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (m) a = m[1];
  return isIP(a) ? a.toLowerCase() : '';
}

function isLoopback(a) {
  return a === '::1' || (isIP(a) === 4 && a.startsWith('127.'));
}

/**
 * Turn the trustProxy setting into a predicate telling whether an address is a trusted proxy.
 * Accepts 'loopback', 'true', 'false' or a comma-separated list of IP addresses; throws on anything else.
 * @param {string} value
 * @returns {(addr: string) => boolean}
 */
export function parseTrustProxy(value) {
  const raw = String(value ?? '').trim();
  const kw = raw.toLowerCase();
  if (kw === 'loopback') return (addr) => isLoopback(normalize(addr));
  if (kw === 'true') return () => true;
  if (kw === 'false') return () => false;
  const set = new Set();
  for (const part of raw.split(',')) {
    const ip = normalize(part);
    if (!ip) throw new Error(`Invalid trustProxy value: ${JSON.stringify(part.trim() || raw)}`);
    set.add(ip);
  }
  return (addr) => set.has(normalize(addr));
}

/** The eight 16-bit groups of a valid IPv6 address, as numbers ('::' expanded, an IPv4 tail split in two). */
function ipv6Groups(addr) {
  const [head, tail] = addr.split('::');
  const parse = (part) => {
    if (!part) return [];
    const out = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        const [a, b, c, d] = g.split('.').map(Number);
        out.push((a << 8) | b, (c << 8) | d);
      } else {
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const left = parse(head);
  const right = parse(tail);
  return tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The key the abuse limits count an address under. An IPv6 address counts as its /64 network: the last 64 bits only
 * pick a device within a network (RFC 4291, section 2.5.1), and a home or office gets at least a whole /64 (RFC 6177),
 * so one visitor can use many addresses in it. An IPv4 address counts as itself.
 * @param {string} ip a client address as returned by clientIp (IPv4-mapped IPv6 is already plain IPv4)
 * @returns {string} e.g. '203.0.113.9', or '2001:db8:0:1::/64' for any address in that /64; '' for ''
 */
export function limitKey(ip) {
  const addr = String(ip ?? '').split('%')[0];
  if (isIP(addr) !== 6) return ip;
  return ipv6Groups(addr.toLowerCase()).slice(0, 4).map((g) => g.toString(16)).join(':') + '::/64';
}

/**
 * Work out the real client address. X-Forwarded-For is only read when the socket peer is trusted;
 * it is walked right to left, skipping trusted hops, and the first untrusted entry wins.
 * @param {{ socket: { remoteAddress?: string }, headers: Record<string, string | string[] | undefined> }} req
 * @param {(addr: string) => boolean} isTrusted
 * @returns {string} the client IP, or '' if the peer address is unknown
 */
export function clientIp(req, isTrusted) {
  const peer = normalize(req.socket?.remoteAddress);
  if (!peer || !isTrusted(peer)) return peer;
  let header = req.headers?.['x-forwarded-for'];
  if (Array.isArray(header)) header = header.join(',');
  if (typeof header !== 'string') return peer;
  const entries = header.split(',').map(normalize).filter(Boolean);
  if (entries.length === 0) return peer;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isTrusted(entries[i])) return entries[i];
  }
  return entries[0];
}
