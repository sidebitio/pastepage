// Local image store: encrypted payloads in IndexedDB. The storage key is derived from the session key and the
// server's `share`, so once the session ends (and `share` is gone) the copies cannot be read. Never throws.
import { unb64u, encryptJSON, decryptJSON } from './crypto.js';

/** Total size limit for all stored records, in bytes. */
export const CAP_BYTES = 500 * 1024 * 1024;

const DB_NAME = 'pastepage';
const STORE = 'images';
const INFO = 'pastepage local images v1';

/**
 * Derive the AES-GCM-256 storage key (HKDF-SHA-256, salt = share, info = fixed label). Not extractable.
 * @param {Uint8Array} aesBits the session's 32 AES key bytes (bytes 0-31 of the key bits)
 * @param {string} share the server's 32-byte share, base64url
 * @returns {Promise<CryptoKey>}
 */
export async function deriveStorageKey(aesBits, share) {
  const s = globalThis.crypto.subtle;
  const base = await s.importKey('raw', aesBits, 'HKDF', false, ['deriveKey']);
  return s.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64u(share), info: new TextEncoder().encode(INFO) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Which records to delete: the expired ones, then the oldest by savedAt until the rest fit in the cap.
 * A record is expired when expires <= nowSeconds. Pure.
 * @param {{sessionId: string, seq: number, savedAt: number, expires: number, size: number}[]} records
 * @param {number} nowSeconds Unix seconds
 * @param {number} capBytes
 * @returns {[string, number][]} [sessionId, seq] pairs
 */
export function sweepPlan(records, nowSeconds, capBytes) {
  const out = [];
  const live = [];
  for (const r of records) (r.expires <= nowSeconds ? out.push([r.sessionId, r.seq]) : live.push(r));
  let total = live.reduce((n, r) => n + (r.size || 0), 0);
  live.sort((a, b) => a.savedAt - b.savedAt);
  for (const r of live) {
    if (total <= capBytes) break;
    out.push([r.sessionId, r.seq]);
    total -= r.size || 0;
  }
  return out;
}

/** The sweepPlan input for one stored record (drops the payload). Pure. */
export const recordMeta = (r) => ({ sessionId: r.sessionId, seq: r.seq, savedAt: r.savedAt, expires: r.expires,
  size: r.size ?? ((r.iv?.length ?? 0) + (r.ct?.length ?? 0)) });

// Promise wrapper around an IDBRequest.
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
// Resolves when the transaction has committed.
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const rangeOf = (sessionId, lo, hi) => IDBKeyRange.bound([sessionId, lo], [sessionId, hi]);

/**
 * Open (and create if needed) the database.
 * @returns {Promise<IDBDatabase|null>} null when IndexedDB is missing, blocked or fails
 */
export async function openStore() {
  try {
    if (!globalThis.indexedDB) return null;
    return await new Promise((res) => {
      const o = globalThis.indexedDB.open(DB_NAME, 1);
      o.onupgradeneeded = () => o.result.createObjectStore(STORE, { keyPath: ['sessionId', 'seq'] }).createIndex('sessionId', 'sessionId');
      o.onsuccess = () => res(o.result);
      o.onerror = o.onblocked = () => res(null);
    });
  } catch { return null; }
}

/**
 * Encrypt and store a payload. Record: {sessionId, seq, iv, ct, savedAt (ms), expires (s), size (iv+ct chars)}.
 * @returns {Promise<boolean>} false on any failure
 */
export async function saveImage(store, key, { sessionId, seq, payload, expires }) {
  try {
    if (!store) return false;
    const { iv, ct } = await encryptJSON(key, payload);
    const tx = store.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ sessionId, seq, iv, ct, savedAt: Date.now(), expires, size: iv.length + ct.length });
    await done(tx);
    return true;
  } catch { return false; }
}

/**
 * Load and decrypt a payload.
 * @returns {Promise<*|null>} null when missing or not decryptable (e.g. a reused session id)
 */
export async function loadImage(store, key, sessionId, seq) {
  try {
    if (!store) return null;
    const rec = await req(store.transaction(STORE).objectStore(STORE).get([sessionId, seq]));
    return rec ? await decryptJSON(key, rec) : null;
  } catch { return null; }
}

// Run `fn(objectStore)` in a readwrite transaction; swallow failures.
async function write(store, fn) {
  try {
    if (!store) return;
    const tx = store.transaction(STORE, 'readwrite');
    fn(tx.objectStore(STORE));
    await done(tx);
  } catch { /* storage problems never reach the page */ }
}

/** Delete one record. */
export const deleteImage = (store, sessionId, seq) => write(store, (os) => os.delete([sessionId, seq]));

/** Delete a session's records with seq <= the given one. */
export const deleteUpTo = (store, sessionId, seq) => write(store, (os) => os.delete(rangeOf(sessionId, -Infinity, seq)));

/** Delete all of a session's records. */
export const deleteSession = (store, sessionId) => write(store, (os) => os.delete(rangeOf(sessionId, -Infinity, Infinity)));

/** Set `expires` (Unix seconds) on all of a session's records. */
export async function setExpiry(store, sessionId, expires) {
  try {
    if (!store) return;
    const tx = store.transaction(STORE, 'readwrite');
    const cur = tx.objectStore(STORE).index('sessionId').openCursor(IDBKeyRange.only(sessionId));
    cur.onsuccess = () => { const c = cur.result; if (c) { c.update({ ...c.value, expires }); c.continue(); } };
    await done(tx);
  } catch { /* ignore */ }
}

/** Delete expired records and, above the cap, the oldest ones. */
export async function sweep(store, nowSeconds) {
  try {
    if (!store) return;
    // Walk the store with a cursor, keeping only each record's metadata, so memory stays at about one record.
    const meta = await new Promise((res, rej) => {
      const out = [];
      const cur = store.transaction(STORE).objectStore(STORE).openCursor();
      cur.onsuccess = () => { const c = cur.result; if (c) { out.push(recordMeta(c.value)); c.continue(); } else res(out); };
      cur.onerror = () => rej(cur.error);
    });
    const plan = sweepPlan(meta, nowSeconds, CAP_BYTES);
    if (plan.length) await write(store, (os) => { for (const k of plan) os.delete(k); });
  } catch { /* ignore */ }
}
