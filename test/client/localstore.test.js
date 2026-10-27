// Tests for public/js/localstore.js: storage key, sweep plan, no-IndexedDB fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStorageKey, sweepPlan, recordMeta, openStore, saveImage, loadImage, CAP_BYTES } from '../../public/js/localstore.js';
import { encryptJSON, decryptJSON, b64u } from '../../public/js/crypto.js';

const bits = (n) => new Uint8Array(32).fill(n);
const share = (n) => b64u(new Uint8Array(32).fill(n));

test('localstore: cap is 500 MB', () => assert.equal(CAP_BYTES, 500 * 1024 * 1024));

test('localstore: storage key is deterministic, not extractable, bound to share and key', async () => {
  const a = await deriveStorageKey(bits(1), share(2));
  const b = await deriveStorageKey(bits(1), share(2));
  assert.equal(a.extractable, false);
  assert.deepEqual(a.algorithm, { name: 'AES-GCM', length: 256 });
  const n = await encryptJSON(a, { hello: 'world' });
  assert.deepEqual(await decryptJSON(b, n), { hello: 'world' });
  await assert.rejects(decryptJSON(await deriveStorageKey(bits(1), share(3)), n));
  await assert.rejects(decryptJSON(await deriveStorageKey(bits(9), share(2)), n));
});

test('localstore: sweepPlan removes expired records only when under the cap', () => {
  const r = [
    { sessionId: 'a', seq: 1, savedAt: 1, expires: 100, size: 10 },
    { sessionId: 'a', seq: 2, savedAt: 2, expires: 500, size: 10 },
    { sessionId: 'b', seq: 1, savedAt: 3, expires: 100, size: 10 },
  ];
  assert.deepEqual(sweepPlan(r, 200, 1000), [['a', 1], ['b', 1]]);
  assert.deepEqual(sweepPlan(r, 50, 1000), []);
});

test('localstore: sweepPlan drops the oldest savedAt first until the total fits', () => {
  const r = [
    { sessionId: 'a', seq: 1, savedAt: 30, expires: 900, size: 40 },
    { sessionId: 'a', seq: 2, savedAt: 10, expires: 900, size: 40 },
    { sessionId: 'b', seq: 1, savedAt: 20, expires: 900, size: 40 },
  ];
  assert.deepEqual(sweepPlan(r, 0, 100), [['a', 2]]);
  assert.deepEqual(sweepPlan(r, 0, 50), [['a', 2], ['b', 1]]);
  assert.deepEqual(sweepPlan(r, 0, 120), []);
});

test('localstore: sweepPlan counts expired records out of the total', () => {
  const r = [
    { sessionId: 'a', seq: 1, savedAt: 1, expires: 5, size: 90 },
    { sessionId: 'a', seq: 2, savedAt: 2, expires: 900, size: 60 },
  ];
  assert.deepEqual(sweepPlan(r, 10, 100), [['a', 1]]);
});

test('localstore: without IndexedDB everything degrades quietly', async () => {
  assert.equal(await openStore(), null);
  const key = await deriveStorageKey(bits(1), share(2));
  assert.equal(await saveImage(null, key, { sessionId: 'a', seq: 1, payload: {}, expires: 1 }), false);
  assert.equal(await loadImage(null, key, 'a', 1), null);
});

test('localstore: recordMeta keeps only the sweep fields and falls back to payload length for size', () => {
  const r = { sessionId: 's', seq: 3, savedAt: 5, expires: 9, iv: 'abc', ct: 'defgh', extra: 'x' };
  assert.deepEqual(recordMeta(r), { sessionId: 's', seq: 3, savedAt: 5, expires: 9, size: 8 });
  assert.equal(recordMeta({ ...r, size: 42 }).size, 42);
});
