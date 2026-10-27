// Tests for the pure image logic in public/js/image.js: what a paste or drop brings in, the size ladder (with a fake
// encoder), checking a received image, and the details line. Also checks that IMAGE_BUDGET really fits the server's
// default note limit once encrypted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  IMAGE_BUDGET, IMAGE_TYPES, SCALE_STEPS, clipboardPlan, dropPlan, fitImage, imageDetails, ladder, sniffMime,
  toBase64, validImage, fromBase64,
} from '../../public/js/image.js';
import { encryptJSON } from '../../public/js/crypto.js';
import { DEFAULTS } from '../../src/config.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
const GIF = [...'GIF89a'].map((c) => c.charCodeAt(0));
const WEBP = [...'RIFF'].map((c) => c.charCodeAt(0)).concat([1, 2, 3, 4], [...'WEBPVP8 '].map((c) => c.charCodeAt(0)));
const b64 = (arr) => Buffer.from(Uint8Array.from(arr)).toString('base64');
const file = (type) => ({ type, name: 'x' });

/* ---------- clipboard and drop ---------- */

test('paste: image only', () => {
  const png = file('image/png');
  assert.deepEqual(clipboardPlan([png], ''), { image: png, refused: false, text: '' });
});

test('paste: text only is left to the text paste', () => {
  assert.deepEqual(clipboardPlan([], 'hello\r\n'), { image: null, refused: false, text: 'hello\r\n' });
  assert.deepEqual(clipboardPlan([], ''), { image: null, refused: false, text: '' });
});

test('paste: image and text together: the image is attached and the text goes in the box', () => {
  const png = file('image/png');
  assert.deepEqual(clipboardPlan([png], 'caption'), { image: png, refused: false, text: 'caption' });
});

test('paste: only the first supported image counts; other formats of it are ignored', () => {
  const tiff = file('image/tiff');
  const png = file('image/png');
  const jpg = file('image/jpeg');
  assert.equal(clipboardPlan([tiff, png, jpg], '').image, png);
  assert.equal(clipboardPlan([tiff, png], '').refused, false);
});

test('paste: an SVG or another file without a supported image is refused, and its text still pastes', () => {
  assert.deepEqual(clipboardPlan([file('image/svg+xml')], ''), { image: null, refused: true, text: '' });
  assert.deepEqual(clipboardPlan([file('application/pdf')], 'report.pdf'), { image: null, refused: true, text: 'report.pdf' });
});

test('drop: every supported image, in order; the others are counted as refused', () => {
  const a = file('image/png');
  const b = file('image/gif');
  const c = file('image/svg+xml');
  assert.deepEqual(dropPlan([a, c, b]), { images: [a, b], refused: 1 });
  assert.deepEqual(dropPlan([]), { images: [], refused: 0 });
});

/* ---------- sniffing ---------- */

test('sniff: the four formats by their first bytes, anything else is null', () => {
  assert.equal(sniffMime(Uint8Array.from(PNG)), 'image/png');
  assert.equal(sniffMime(Uint8Array.from(JPEG)), 'image/jpeg');
  assert.equal(sniffMime(Uint8Array.from(GIF)), 'image/gif');
  assert.equal(sniffMime(Uint8Array.from(WEBP)), 'image/webp');
  assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffMime(new Uint8Array(0)), null);
  assert.deepEqual(IMAGE_TYPES, ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
});

test('base64: round trip, padded, large input', () => {
  const bytes = Uint8Array.from({ length: 100003 }, (_, i) => (i * 7) & 255);
  const s = toBase64(bytes);
  assert.equal(s, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(fromBase64(s), bytes);
});

/* ---------- the ladder ---------- */

/** A fake encoder: records each call and answers with the size the test gives for that step. */
function fakeEncoder(sizeFor) {
  const calls = [];
  const encode = async (step) => {
    calls.push(step);
    const r = sizeFor(step, calls.length);
    return r === null ? null : { bytes: r, mime: step.type, w: 1, h: 1 };
  };
  return { calls, encode };
}

const big = { bytes: 4_000_000, mime: 'image/png', w: 3000, h: 2000 };

test('ladder: the original is kept when it fits, without encoding anything', async () => {
  const { calls, encode } = fakeEncoder(() => 1);
  const r = await fitImage({ ...big, bytes: IMAGE_BUDGET }, encode, { webp: true });
  assert.deepEqual(r, { ok: true, step: 'original', out: null });
  assert.equal(calls.length, 0);
});

test('ladder: stops at the first step that fits', async () => {
  const { calls, encode } = fakeEncoder((s) => (s.quality === 0.85 && s.maxSide === null ? 500_000 : 2_000_000));
  const r = await fitImage(big, encode, { webp: true });
  assert.equal(r.ok, true);
  assert.equal(r.step, 'lossy-0.85');
  assert.equal(r.out.bytes, 500_000);
  assert.deepEqual(calls.map((c) => c.name), ['lossless', 'lossy-0.92', 'lossy-0.85']);
});

test('ladder: with WebP, lossless WebP, lossy WebP, then smaller sizes from large to small', () => {
  const steps = ladder(big, true);
  assert.deepEqual(steps.map((s) => [s.name, s.type, s.quality, s.maxSide]), [
    ['lossless', 'image/webp', 1, null],
    ['lossy-0.92', 'image/webp', 0.92, null],
    ['lossy-0.85', 'image/webp', 0.85, null],
    ['scale-2560', 'image/webp', 0.85, 2560],
    ['scale-1920', 'image/webp', 0.85, 1920],
    ['scale-1280', 'image/webp', 0.85, 1280],
  ]);
  assert.deepEqual(SCALE_STEPS, [2560, 1920, 1280]);
});

test('ladder: without WebP (Safari), PNG for lossless and JPEG for the lossy steps', () => {
  const steps = ladder(big, false);
  assert.deepEqual(steps.map((s) => s.type), ['image/png', 'image/jpeg', 'image/jpeg', 'image/jpeg', 'image/jpeg', 'image/jpeg']);
});

test('ladder: scale steps at or above the long side are skipped', () => {
  assert.deepEqual(ladder({ ...big, w: 2000, h: 1500 }, true).map((s) => s.name),
    ['lossless', 'lossy-0.92', 'lossy-0.85', 'scale-1920', 'scale-1280']);
  assert.deepEqual(ladder({ ...big, w: 1280, h: 4000 }, true).map((s) => s.name),
    ['lossless', 'lossy-0.92', 'lossy-0.85', 'scale-2560', 'scale-1920', 'scale-1280']);
  assert.deepEqual(ladder({ ...big, w: 1000, h: 800 }, true).map((s) => s.name), ['lossless', 'lossy-0.92', 'lossy-0.85']);
});

test('ladder: refuses when nothing fits, after trying every step in order', async () => {
  const { calls, encode } = fakeEncoder(() => 2_000_000);
  const r = await fitImage(big, encode, { webp: true });
  assert.deepEqual(r, { ok: false, reason: 'tooLarge' });
  assert.deepEqual(calls.map((c) => c.maxSide), [null, null, null, 2560, 1920, 1280]);
});

test('ladder: a step the encoder cannot do is skipped', async () => {
  const { encode } = fakeEncoder((s) => (s.name === 'lossless' ? null : 10));
  assert.equal((await fitImage(big, encode, { webp: true })).step, 'lossy-0.92');
});

test('ladder: a GIF is never converted; too large is refused as a GIF', async () => {
  const { calls, encode } = fakeEncoder(() => 1);
  assert.deepEqual(await fitImage({ ...big, mime: 'image/gif' }, encode, { webp: true }), { ok: false, reason: 'gif' });
  assert.equal(calls.length, 0);
  assert.equal((await fitImage({ ...big, mime: 'image/gif', bytes: 1000 }, encode, { webp: true })).step, 'original');
});

/* ---------- the budget against the server's limit ---------- */

test('budget: an image of IMAGE_BUDGET bytes plus a caption fits the default maxNoteBytes once encrypted', async () => {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
  const bytes = Uint8Array.from({ length: IMAGE_BUDGET }, (_, i) => (i * 31) & 255); // base64 size does not depend on the content
  const payload = {
    v: 1, t: 'x'.repeat(40_000), l: 'plaintext', n: 'Å'.repeat(40), c: 'c'.repeat(32), r: 123456,
    image: { mime: 'image/webp', data: toBase64(bytes), w: 2560, h: 1707, bytes: IMAGE_BUDGET, orig: { mime: 'image/png', bytes: 12_345_678 } },
  };
  const { ct } = await encryptJSON(key, payload);
  assert.ok(ct.length <= DEFAULTS.maxNoteBytes, `ct is ${ct.length} characters`);
});

/* ---------- received images ---------- */

const good = () => ({ mime: 'image/png', data: b64(PNG), w: 1280, h: 800, bytes: 12, orig: { mime: 'image/png', bytes: 12 } });

test('valid: a good image comes back with its size worked out from the data', () => {
  const v = validImage({ ...good(), bytes: 999999 });
  assert.deepEqual(v, { mime: 'image/png', data: b64(PNG), w: 1280, h: 800, bytes: 12, orig: { mime: 'image/png', bytes: 12 } });
});

test('valid: a missing or odd orig falls back to the sent type and size', () => {
  const { orig, ...noOrig } = good();
  assert.deepEqual(validImage(noOrig).orig, { mime: 'image/png', bytes: 12 });
  assert.deepEqual(validImage({ ...good(), orig: { mime: 'image/svg+xml', bytes: 5 } }).orig, { mime: 'image/png', bytes: 12 });
  assert.deepEqual(validImage({ ...good(), orig: { mime: 'image/jpeg', bytes: -1 } }).orig, { mime: 'image/png', bytes: 12 });
  assert.deepEqual(validImage({ ...good(), orig: { mime: 'image/jpeg', bytes: 3_000_000 } }).orig, { mime: 'image/jpeg', bytes: 3_000_000 });
});

test('valid: a bad mime is rejected', () => {
  for (const mime of ['image/svg+xml', 'text/html', 'image/PNG', '', null, 5]) assert.equal(validImage({ ...good(), mime }), null, String(mime));
});

test('valid: data that is not base64, or not the format it claims, is rejected', () => {
  for (const data of ['', 'abc', 'iVBO!!==', `${b64(PNG)}\n`, `"><script>`, b64(JPEG), 42, null]) {
    assert.equal(validImage({ ...good(), data }), null, String(data));
  }
  assert.ok(validImage({ ...good(), mime: 'image/jpeg', data: b64(JPEG) }));
  assert.ok(validImage({ ...good(), mime: 'image/gif', data: b64(GIF) }));
  assert.ok(validImage({ ...good(), mime: 'image/webp', data: b64(WEBP) }));
});

test('valid: width and height must be positive whole numbers', () => {
  for (const [w, h] of [[0, 1], [1, 0], [-5, 5], [1.5, 2], ['10', 10], [10, null], [Infinity, 1], [100000, 1]]) {
    assert.equal(validImage({ ...good(), w, h }), null, `${w}x${h}`);
  }
});

test('valid: not an object is rejected', () => {
  for (const x of [null, undefined, 'image', 3, []]) assert.equal(validImage(x), null);
});

/* ---------- the details line ---------- */

const t = (key, vars = {}) => ({ 'size.b': '{n} B', 'size.kb': '{n} KB', 'size.mb': '{n} MB' })[key].replace(/\{(\w+)\}/g, (_, k) => vars[k]);

test('details: sent as is', () => {
  assert.equal(imageDetails({ mime: 'image/png', bytes: 655360, orig: { mime: 'image/png', bytes: 655360 } }, t), 'PNG 640 KB');
  assert.equal(imageDetails({ mime: 'image/gif', bytes: 900, orig: { mime: 'image/gif', bytes: 900 } }, t), 'GIF 900 B');
});

test('details: converted', () => {
  assert.equal(imageDetails({ mime: 'image/webp', bytes: 655360, orig: { mime: 'image/png', bytes: 3355443 } }, t), 'PNG 3.2 MB → WebP 640 KB');
  assert.equal(imageDetails({ mime: 'image/jpeg', bytes: 700000, orig: { mime: 'image/jpeg', bytes: 5000000 } }, t), 'JPEG 4.8 MB → JPEG 684 KB');
});
