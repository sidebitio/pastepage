// In-memory session store: sessions as append-only lists of encrypted events, with limits, expiry and sweeping.
import { EventEmitter } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

const MIN_HOURS = 1;
const EVENT_OVERHEAD = 64;

/**
 * Hash the access token for storage.
 * @param {string} authHex the 64-character hex token; its text (not decoded bytes) is hashed
 * @returns {string} lowercase sha256 hex
 */
export function hashAuth(authHex) {
  return createHash('sha256').update(authHex, 'utf8').digest('hex');
}

/**
 * Clamp a requested lifetime to 1..maxHours; missing or invalid input gives defaultHours (also clamped).
 * @param {unknown} hours requested lifetime in hours
 * @param {{maxHours: number, defaultHours: number}} limits from the config
 * @returns {number} hours
 */
function clampHours(hours, { maxHours, defaultHours }) {
  const h = Number(hours ?? defaultHours);
  return Math.min(maxHours, Math.max(MIN_HOURS, Number.isFinite(h) ? h : defaultHours));
}

/** Bytes an event with ciphertext costs: iv + ct + fixed overhead. Delete and clear events are pushed with 0. */
function eventBytes(ev) {
  return (ev.ct?.length ?? 0) + (ev.iv?.length ?? 0) + EVENT_OVERHEAD;
}

/**
 * Build the wire shape of an internal event. Burn events never expose iv or ct.
 * @param {object} ev internal event
 * @returns {object} event as sent to clients
 */
function toWire(ev) {
  const { seq, ts, kind } = ev;
  switch (kind) {
    case 'note':
    case 'meta':
      return { seq, ts, kind, client: ev.client, iv: ev.iv, ct: ev.ct };
    case 'burn':
      return { seq, ts, kind, client: ev.client, size: ev.size };
    case 'delete':
      return { seq, ts, kind, target: ev.target };
    case 'burned':
      return { seq, ts, kind, target: ev.target, client: ev.client };
    default:
      return { seq, ts, kind };
  }
}

/**
 * Sessions held in memory. Emits 'event' (id, wireEvent), 'session' (id, { expires })
 * and 'ended' (id, reason). Has no timers; call sweep() periodically.
 */
export class SessionStore extends EventEmitter {
  #sessions = new Map();
  #totalBytes = 0;

  /**
   * @param {object} config limits from loadConfig
   * @param {() => number} now clock in milliseconds
   */
  constructor(config, now = () => Date.now()) {
    super();
    this.config = config;
    this.now = now;
  }

  /** Number of live sessions. */
  get size() { return this.#sessions.size; }

  /** Bytes held across all sessions. */
  get totalBytes() { return this.#totalBytes; }

  #seconds() { return Math.floor(this.now() / 1000); }

  /**
   * Create a session.
   * @param {{id: string, authHash: string, hours?: number}} opts hours defaults to config.defaultHours, clamped to 1..config.maxHours
   * @returns {object} the new session
   * @throws {AppError} TAKEN if the id exists, SERVER_FULL at maxSessions
   */
  create({ id, authHash, hours }) {
    if (this.#sessions.has(id)) throw new AppError('TAKEN');
    if (this.#sessions.size >= this.config.maxSessions) throw new AppError('SERVER_FULL');
    const session = {
      id,
      authHash,
      expires: this.#seconds() + Math.floor(clampHours(hours, this.config) * 3600),
      present: 0,
      lastSeq: 0,
      clearedSeq: 0,
      events: [],
      bytes: 0,
      emptySince: this.now(),
    };
    this.#sessions.set(id, session);
    return session;
  }

  /** @returns {object|undefined} the session with this id, if any */
  get(id) { return this.#sessions.get(id); }

  /**
   * Look up a session and verify its access hash in constant time.
   * @returns {object|null} the session, or null for an unknown id or wrong hash
   */
  check(id, authHash) {
    const session = this.#sessions.get(id);
    if (!session) return null;
    const a = Buffer.from(String(authHash));
    const b = Buffer.from(session.authHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return session;
  }

  /** Add an event to the session and broadcast it; returns the wire event. */
  #push(session, fields, bytes) {
    const ev = { seq: ++session.lastSeq, ts: this.#seconds(), bytes, ...fields };
    session.events.push(ev);
    session.bytes += bytes;
    this.#totalBytes += bytes;
    const wire = toWire(ev);
    this.emit('event', session.id, wire);
    return wire;
  }

  /** Remove stored events from a session, freeing their bytes. */
  #drop(session, predicate) {
    const kept = [];
    for (const ev of session.events) {
      if (predicate(ev)) {
        session.bytes -= ev.bytes;
        this.#totalBytes -= ev.bytes;
      } else kept.push(ev);
    }
    session.events = kept;
  }

  /**
   * Append an encrypted event.
   * @param {object} session
   * @param {{kind: 'note'|'burn'|'meta', client: string, iv: string, ct: string}} ev
   * @returns {object} the wire event
   * @throws {AppError} TOO_LARGE for an oversized event, SESSION_FULL or SERVER_FULL at a limit
   */
  append(session, { kind, client, iv, ct }) {
    const { maxNoteBytes, maxMetaBytes, maxEvents, maxSessionBytes, maxTotalBytes } = this.config;
    if (ct.length > (kind === 'meta' ? maxMetaBytes : maxNoteBytes)) throw new AppError('TOO_LARGE');
    const bytes = eventBytes({ iv, ct });
    if (session.events.length >= maxEvents || session.bytes + bytes > maxSessionBytes) throw new AppError('SESSION_FULL');
    if (this.#totalBytes + bytes > maxTotalBytes) throw new AppError('SERVER_FULL');
    const fields = kind === 'burn' ? { kind, client, iv, ct, size: ct.length } : { kind, client, iv, ct };
    return this.#push(session, fields, bytes);
  }

  /**
   * Delete a note or burn note, removing its ciphertext, and record a delete event.
   * @returns {object} the delete wire event
   * @throws {AppError} GONE if target is missing or not a note/burn
   */
  deleteNote(session, target) {
    const ev = session.events.find((e) => e.seq === target);
    if (!ev || (ev.kind !== 'note' && ev.kind !== 'burn')) throw new AppError('GONE');
    this.#drop(session, (e) => e === ev);
    return this.#push(session, { kind: 'delete', target }, 0);
  }

  /**
   * Release a burn note's ciphertext exactly once, to a client other than its sender, and delete it.
   * The placeholder stays in the event list without iv/ct; a 'burned' event is appended and emitted.
   * Synchronous on purpose: check and removal happen with no await in between.
   * @param {object} session
   * @param {number} target seq of the burn event
   * @param {string} client the opening client's id
   * @returns {{iv: string, ct: string}} the ciphertext
   * @throws {AppError} GONE if target is unknown, not a burn note or already opened; FORBIDDEN for the sender
   */
  burnOpen(session, target, client) {
    const ev = session.events.find((e) => e.seq === target);
    if (!ev || ev.kind !== 'burn' || ev.ct === undefined) throw new AppError('GONE');
    if (ev.client === client) throw new AppError('FORBIDDEN');
    const { iv, ct } = ev;
    const freed = ev.bytes - EVENT_OVERHEAD;
    delete ev.iv;
    delete ev.ct;
    ev.bytes = EVENT_OVERHEAD;
    session.bytes -= freed;
    this.#totalBytes -= freed;
    this.#push(session, { kind: 'burned', target, client }, 0);
    return { iv, ct };
  }

  /** Remove all events, leaving one clear event; seq numbers continue. Returns the clear wire event. */
  clear(session) {
    this.#drop(session, () => true);
    const wire = this.#push(session, { kind: 'clear' }, 0);
    session.clearedSeq = wire.seq;
    return wire;
  }

  /**
   * Set the expiry to now plus the given hours (clamped to 1..config.maxHours) and emit 'session'.
   * @returns {number} the new expiry in Unix seconds
   */
  setExpiry(session, hours) {
    session.expires = this.#seconds() + Math.floor(clampHours(hours, this.config) * 3600);
    this.emit('session', session.id, { expires: session.expires });
    return session.expires;
  }

  /** End a session, free its bytes and emit 'ended'. Unknown ids are ignored. */
  end(id, reason) {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#totalBytes -= session.bytes;
    this.#sessions.delete(id);
    this.emit('ended', id, reason);
  }

  /**
   * Events a client needs after `since`.
   * @returns {{mode: 'snapshot'|'delta', events: object[]}} a snapshot when since is negative,
   *   before the last clear, or beyond the last seq; otherwise the events with seq > since
   */
  eventsSince(session, since) {
    if (since < 0 || since < session.clearedSeq || since > session.lastSeq) {
      return { mode: 'snapshot', events: session.events.map(toWire) };
    }
    return { mode: 'delta', events: session.events.filter((e) => e.seq > since).map(toWire) };
  }

  /** Record how many distinct clients are connected; remembers when the session became empty. */
  setPresence(session, count) {
    if (count === 0 && session.present !== 0) session.emptySince = this.now();
    session.present = count;
  }

  /** End sessions that have expired or have been empty longer than idleSeconds. */
  sweep() {
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    for (const session of [...this.#sessions.values()]) {
      if (session.expires <= nowSec) this.end(session.id, 'expired');
      else if (session.present === 0 && nowMs - session.emptySince >= this.config.idleSeconds * 1000) this.end(session.id, 'idle');
    }
  }
}
