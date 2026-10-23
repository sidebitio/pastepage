// Tests for public/js/crypto.js: key derivation, AES-GCM round trip, encoders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SALT_PREFIX, ITERATIONS, deriveBits, keysFromBits, encryptJSON, decryptJSON, hex, unhex, b64u, unb64u } from '../../public/js/crypto.js';

test('crypto: constants', () => {
  assert.equal(SALT_PREFIX, 'pastepage/v1:');
  assert.equal(ITERATIONS, 600000);
});

test('crypto: derive is deterministic and salted by id', async () => {
  const a = await keysFromBits(await deriveBits('tq7m8kxph3vdr2', '12-dancing-apes'));
  const b = await keysFromBits(await deriveBits('tq7m8kxph3vdr2', '12-dancing-apes'));
  const c = await keysFromBits(await deriveBits('tq7m8kxph3vdr2', '13-dancing-apes'));
  assert.match(a.auth, /^[0-9a-f]{64}$/);
  assert.equal(a.auth, b.auth);
  assert.notEqual(a.auth, c.auth);
});

test('crypto: exact round trip', async () => {
  const { key } = await keysFromBits(await deriveBits('pw', '12-dancing-apes'));
  const t = '\tTab  trailing  \n\n\nleading blank above\n😀 עברית ​ zero-width\n\n';
  const enc = await encryptJSON(key, { t });
  assert.match(enc.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.match(enc.ct, /^[A-Za-z0-9_-]+$/);
  assert.equal((await decryptJSON(key, enc)).t, t);
});

test('crypto: wrong key fails', async () => {
  const k1 = (await keysFromBits(await deriveBits('pw1', '12-dancing-apes'))).key;
  const k2 = (await keysFromBits(await deriveBits('pw2', '12-dancing-apes'))).key;
  const enc = await encryptJSON(k1, { t: 'x' });
  await assert.rejects(decryptJSON(k2, enc));
});

test('crypto: hex and base64url helpers', () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 255]);
  assert.equal(hex(bytes), '0001fafbff');
  assert.deepEqual(unhex('0001fafbff'), bytes);
  assert.deepEqual(unb64u(b64u(bytes)), bytes);
  const big = new Uint8Array(100000).map((_, i) => i % 251);
  assert.deepEqual(unb64u(b64u(big)), big);
});
