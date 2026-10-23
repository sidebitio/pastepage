// Key derivation (PBKDF2), note encryption (AES-GCM) and hex/base64url helpers. No DOM, works in Node.

/** Salt prefix; the session id is appended. */
export const SALT_PREFIX = 'pastepage/v1:';
/** PBKDF2-SHA256 iteration count. */
export const ITERATIONS = 600000;

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * Hex-encode bytes.
 * @param {Uint8Array} bytes
 * @returns {string} lowercase hex
 */
export const hex = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Decode a hex string.
 * @param {string} s even-length hex string
 * @returns {Uint8Array}
 */
export const unhex = (s) => new Uint8Array((s.match(/../g) || []).map((h) => parseInt(h, 16)));

/**
 * Base64url-encode bytes (no padding). Works in chunks so large data does not overflow the call stack.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string.
 * @param {string} s base64url text (padding optional)
 * @returns {Uint8Array}
 */
export function unb64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/**
 * Derive 512 bits from the password, salted with the session id.
 * @param {string} password normalised session password
 * @param {string} id session id
 * @returns {Promise<Uint8Array>} 64 bytes: first 32 are the AES key, last 32 the access token
 */
export async function deriveBits(password, id) {
  const base = await globalThis.crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(SALT_PREFIX + id), iterations: ITERATIONS }, base, 512);
  return new Uint8Array(bits);
}

/**
 * Split derived bits into an AES-GCM key and the access token.
 * @param {Uint8Array} bits the 64 bytes from deriveBits
 * @returns {Promise<{key: CryptoKey, auth: string}>} key from bits 0-31, auth as hex of bits 32-63
 */
export async function keysFromBits(bits) {
  const key = await globalThis.crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, auth: hex(bits.slice(32)) };
}

/**
 * Encrypt a JSON-serialisable value with AES-GCM and a fresh 12-byte IV.
 * @param {CryptoKey} key
 * @param {*} obj value to encrypt
 * @returns {Promise<{iv: string, ct: string}>} base64url IV and ciphertext
 */
export async function encryptJSON(key, obj) {
  const iv = rand(12);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  return { iv: b64u(iv), ct: b64u(ct) };
}

/**
 * Decrypt a payload made by encryptJSON; rejects on a wrong key or tampered data.
 * @param {CryptoKey} key
 * @param {{iv: string, ct: string}} n base64url IV and ciphertext
 * @returns {Promise<*>} the original value
 */
export async function decryptJSON(key, n) {
  const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(n.iv) }, key, unb64u(n.ct));
  return JSON.parse(td.decode(pt));
}
