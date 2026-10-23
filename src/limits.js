// In-memory abuse limiters keyed by client IP: wrong-password lockout and session-creation rate limit.

const MAX_ENTRIES = 50_000;

/** Drop the oldest entries (Map insertion order) until the map fits the cap. */
function cap(map) {
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

/** Locks an IP out for a while after too many failures within a window. */
export class FailureLimiter {
  #maxFails;
  #windowMs;
  #lockMs;
  #now;
  #map = new Map(); // ip -> { fails: number[], lockedUntil: number }
  #lastPrune = -Infinity;

  /**
   * @param {{ maxFails: number, windowSeconds: number, lockSeconds: number }} opts
   * @param {() => number} [now] clock in milliseconds
   */
  constructor({ maxFails, windowSeconds, lockSeconds }, now = () => Date.now()) {
    this.#maxFails = maxFails;
    this.#windowMs = windowSeconds * 1000;
    this.#lockMs = lockSeconds * 1000;
    this.#now = now;
  }

  // Drop one IP's expired state. Returns its live entry, if any.
  #live(ip, t) {
    const e = this.#map.get(ip);
    if (!e) return undefined;
    if (e.lockedUntil > t) return e;
    if (e.lockedUntil) { this.#map.delete(ip); return undefined; } // lock expired: start fresh
    e.fails = e.fails.filter((f) => t - f < this.#windowMs);
    if (e.fails.length === 0) { this.#map.delete(ip); return undefined; }
    return e;
  }

  // Sweep all IPs, at most once per second so each call stays cheap.
  #prune(t) {
    if (t - this.#lastPrune < 1000) return;
    this.#lastPrune = t;
    for (const ip of [...this.#map.keys()]) this.#live(ip, t);
  }

  /** Whether the IP is currently locked out. */
  isLocked(ip) {
    const t = this.#now();
    this.#prune(t);
    return (this.#live(ip, t)?.lockedUntil ?? 0) > t;
  }

  /** Record a failed attempt; locks the IP once maxFails is reached. A locked IP stays locked, unextended. */
  fail(ip) {
    const t = this.#now();
    this.#prune(t);
    let e = this.#live(ip, t);
    if (e?.lockedUntil > t) return;
    if (!e) {
      e = { fails: [], lockedUntil: 0 };
      this.#map.set(ip, e);
    }
    e.fails.push(t);
    if (e.fails.length >= this.#maxFails) {
      e.fails = [];
      e.lockedUntil = t + this.#lockMs;
    }
    cap(this.#map);
  }

  /** Number of IPs currently tracked. */
  get size() {
    return this.#map.size;
  }
}

/** Sliding-window limiter: at most `limit` allowed calls per IP per window. */
export class RateLimiter {
  #limit;
  #windowMs;
  #now;
  #map = new Map(); // ip -> number[] of allowed call times
  #lastPrune = -Infinity;

  /**
   * @param {{ limit: number, windowSeconds: number }} opts
   * @param {() => number} [now] clock in milliseconds
   */
  constructor({ limit, windowSeconds }, now = () => Date.now()) {
    this.#limit = limit;
    this.#windowMs = windowSeconds * 1000;
    this.#now = now;
  }

  // Drop one IP's expired call times. Returns the live list (possibly empty).
  #live(ip, t) {
    const times = this.#map.get(ip);
    if (!times) return [];
    const kept = times.filter((x) => t - x < this.#windowMs);
    if (kept.length === 0) this.#map.delete(ip);
    else if (kept.length !== times.length) this.#map.set(ip, kept);
    return kept;
  }

  // Sweep all IPs, at most once per second so each call stays cheap.
  #prune(t) {
    if (t - this.#lastPrune < 1000) return;
    this.#lastPrune = t;
    for (const ip of [...this.#map.keys()]) this.#live(ip, t);
  }

  /** Count a call and return whether it is within the limit. Refused calls are not counted. */
  allow(ip) {
    const t = this.#now();
    this.#prune(t);
    const times = this.#live(ip, t);
    if (times.length >= this.#limit) return false;
    times.push(t);
    this.#map.set(ip, times);
    cap(this.#map);
    return true;
  }

  /** Number of IPs currently tracked. */
  get size() {
    return this.#map.size;
  }
}
