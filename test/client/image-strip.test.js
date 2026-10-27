// Tests for stripMetadata in public/js/image.js: hidden data (GPS, camera, comments, XMP) leaves JPEG, PNG, WebP and
// GIF files while the picture, the colour profile and the rotation stay. The files are built by hand, with the word
// SECRET in every place hidden data can hide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitImage, sniffMime, stripMetadata } from '../../public/js/image.js';

const bytes = (s) => [...s].map((c) => c.charCodeAt(0));
const be16 = (n) => [(n >> 8) & 255, n & 255];
const be32 = (n) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const text = (u8) => Buffer.from(u8).toString('latin1');
const hasSecret = (u8) => text(u8).includes('SECRET');

/** A big-endian TIFF (EXIF) block: Orientation, a Make that points at "SECRET-CAMERA", and a GPS pointer. */
function tiff(orientation) {
  const entries = 3;
  const ifdEnd = 8 + 2 + entries * 12 + 4;
  const make = bytes('SECRET-CAMERA\0');
  const gpsAt = ifdEnd + make.length;
  return [
    ...bytes('MM'), 0, 0x2a, ...be32(8), ...be16(entries),
    0x01, 0x0f, 0, 2, ...be32(make.length), ...be32(ifdEnd), // Make
    0x01, 0x12, 0, 3, 0, 0, 0, 1, ...be16(orientation), 0, 0, // Orientation
    0x88, 0x25, 0, 4, 0, 0, 0, 1, ...be32(gpsAt), // GPS IFD pointer
    0, 0, 0, 0,
    ...make,
    0, 1, 0, 1, 0, 2, 0, 0, 0, 2, ...bytes('N\0'), 0, 0, 0, 0, ...bytes('SECRET-GPS'),
  ];
}

const seg = (marker, body) => [0xff, marker, ...be16(body.length + 2), ...body];
const ENTROPY = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]; // a stuffed 0xFF and a restart marker
const ICC = bytes('ICC_PROFILE\0') .concat([1, 1, 9, 9, 9]);

function jpeg(orientation, { trailing = true } = {}) {
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [...bytes('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...bytes('Exif\0\0'), ...tiff(orientation)]),
    ...seg(0xe1, bytes('http://ns.adobe.com/xap/1.0/\0<x>SECRET-XMP</x>')),
    ...seg(0xe2, ICC),
    ...seg(0xe2, bytes('MPF\0SECRET-MPF')),
    ...seg(0xed, bytes('Photoshop 3.0\0SECRET-IPTC')),
    ...seg(0xfe, bytes('SECRET-COMMENT')),
    ...seg(0xdb, [0, ...Array(64).fill(1)]),
    ...seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    ...ENTROPY,
    0xff, 0xd9,
    ...(trailing ? [0xff, 0xd8, ...seg(0xe1, [...bytes('Exif\0\0'), ...tiff(1)]), 0xff, 0xd9] : []),
  ]);
}

/** The JPEG's segment markers in order (not looking inside the compressed picture). */
function markers(u8) {
  const out = [];
  for (let p = 2; p < u8.length;) {
    const m = u8[p + 1];
    out.push(m.toString(16));
    if (m === 0xd9) break;
    p += 2 + ((u8[p + 2] << 8) | u8[p + 3]);
    if (m === 0xda) p += ENTROPY.length;
  }
  return out;
}

test('JPEG: EXIF, GPS, XMP, IPTC, comments and extra pictures go; picture and colour profile stay', () => {
  const out = stripMetadata(jpeg(1), 'image/jpeg');
  assert.equal(out.reencode, false);
  assert.equal(hasSecret(out.bytes), false);
  assert.equal(text(out.bytes).includes('Exif'), false);
  assert.ok(text(out.bytes).includes('ICC_PROFILE'));
  assert.deepEqual(markers(out.bytes), ['e0', 'e2', 'db', 'c0', 'da', 'd9']);
  assert.ok(text(out.bytes).includes(text(Uint8Array.from(ENTROPY))));
  assert.equal(sniffMime(out.bytes), 'image/jpeg');
  assert.deepEqual([...out.bytes.slice(-2)], [0xff, 0xd9]);
});

test('JPEG: a rotated photo keeps only its Orientation, right after the JFIF header', () => {
  const out = stripMetadata(jpeg(6), 'image/jpeg');
  assert.equal(hasSecret(out.bytes), false);
  assert.deepEqual(markers(out.bytes), ['e0', 'e1', 'e2', 'db', 'c0', 'da', 'd9']);
  const app1 = out.bytes.indexOf(0xe1) - 1;
  const len = (out.bytes[app1 + 2] << 8) | out.bytes[app1 + 3];
  assert.equal(len, 34);
  const block = out.bytes.subarray(app1 + 4, app1 + 2 + len);
  assert.equal(text(block.subarray(0, 6)), 'Exif\0\0');
  // After "Exif\0\0", the TIFF header and the entry count: one entry, tag 0x0112, type SHORT, count 1, value 6.
  assert.deepEqual([...block.subarray(16, 28)], [0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]);
  // Cleaning again changes nothing.
  assert.deepEqual(stripMetadata(out.bytes, 'image/jpeg').bytes, out.bytes);
});

test('JPEG: without a JFIF header the Orientation goes right after the start', () => {
  const src = jpeg(8);
  const noJfif = Uint8Array.from([0xff, 0xd8, ...src.subarray(2 + 18)]);
  const out = stripMetadata(noJfif, 'image/jpeg');
  assert.deepEqual(markers(out.bytes).slice(0, 2), ['e1', 'e2']);
});

test('JPEG: a cut-off file is not readable (it gets converted instead)', () => {
  const src = jpeg(1, { trailing: false });
  assert.equal(stripMetadata(src.subarray(0, src.length - 2), 'image/jpeg'), null);
  assert.equal(stripMetadata(src.subarray(0, 30), 'image/jpeg'), null);
});

const chunk = (type, data) => [...be32(data.length), ...bytes(type), ...data, 1, 2, 3, 4]; // CRC is not checked
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(orientation) {
  return Uint8Array.from([
    ...PNG_SIG,
    ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    ...chunk('iCCP', bytes('Display P3\0\0xyz')),
    ...chunk('tEXt', bytes('Comment\0SECRET-TEXT')),
    ...chunk('iTXt', bytes('XML:com.adobe.xmp\0\0\0\0\0SECRET-XMP')),
    ...chunk('eXIf', tiff(orientation)),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('tIME', [7, 234, 10, 27, 1, 2, 3]),
    ...chunk('IEND', []),
    ...bytes('SECRET-AFTER-END'),
  ]);
}

const pngTypes = (u8) => {
  const out = [];
  for (let p = 8; p < u8.length; p += 12 + ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3])) out.push(text(u8.subarray(p + 4, p + 8)));
  return out;
};

test('PNG: text, XMP, EXIF and the time go; pixels and colour profile stay', () => {
  const out = stripMetadata(png(1), 'image/png');
  assert.equal(out.reencode, false);
  assert.equal(hasSecret(out.bytes), false);
  assert.deepEqual(pngTypes(out.bytes), ['IHDR', 'iCCP', 'IDAT', 'IEND']);
  assert.equal(sniffMime(out.bytes), 'image/png');
});

test('PNG: an EXIF rotation means it is converted, so it still shows upright', () => {
  assert.equal(stripMetadata(png(6), 'image/png').reencode, true);
});

test('PNG: a cut-off file is not readable', () => {
  const src = png(1);
  assert.equal(stripMetadata(src.subarray(0, 60), 'image/png'), null);
});

const riff = (type, data) => [...bytes(type), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];

function webp(orientation) {
  const body = [
    ...bytes('WEBP'),
    ...riff('VP8X', [0x20 | 0x10 | 0x08 | 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ...riff('ICCP', [9, 9, 9]),
    ...riff('VP8L', [0x2f, 0, 0, 0, 1]),
    ...riff('EXIF', tiff(orientation)),
    ...riff('XMP ', bytes('<x>SECRET-XMP</x>')),
  ];
  return Uint8Array.from([...bytes('RIFF'), ...le32(body.length), ...body]);
}

test('WebP: EXIF and XMP go, their flags are cleared and the size is right', () => {
  const out = stripMetadata(webp(1), 'image/webp');
  assert.equal(out.reencode, false);
  assert.equal(hasSecret(out.bytes), false);
  const b = out.bytes;
  assert.equal(new DataView(b.buffer).getUint32(4, true), b.length - 8);
  assert.equal(text(b.subarray(12, 16)), 'VP8X');
  assert.equal(b[20], 0x30); // ICC and alpha flags stay, EXIF and XMP flags are gone
  assert.ok(text(b).includes('ICCP') && text(b).includes('VP8L'));
  assert.equal(sniffMime(b), 'image/webp');
});

test('WebP: an EXIF rotation means it is converted', () => {
  assert.equal(stripMetadata(webp(3), 'image/webp').reencode, true);
});

function gif() {
  const sub = (data) => [data.length, ...data];
  return Uint8Array.from([
    ...bytes('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
    0x21, 0xff, 11, ...bytes('NETSCAPE2.0'), ...sub([1, 0, 0]), 0,
    0x21, 0xff, 11, ...bytes('XMP DataXMP'), ...sub(bytes('<x>SECRET-XMP</x>')), 0,
    0x21, 0xfe, ...sub(bytes('SECRET-COMMENT')), 0,
    0x21, 0xf9, ...sub([0, 10, 0, 0]), 0,
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, ...sub([0x44, 0x01]), 0,
    0x3b,
  ]);
}

test('GIF: comments and XMP go; the loop count and frames stay', () => {
  const out = stripMetadata(gif(), 'image/gif');
  assert.equal(hasSecret(out.bytes), false);
  assert.ok(text(out.bytes).includes('NETSCAPE2.0'));
  assert.deepEqual([...out.bytes.slice(-1)], [0x3b]);
  assert.equal(out.bytes.length, gif().length - (3 + 11 + 1 + 17 + 1) - (2 + 1 + 14 + 1));
});

test('fitImage: reencode skips the original even when it fits', async () => {
  const steps = [];
  const encode = async (s) => { steps.push(s.name); return { bytes: 10, mime: s.type, w: 1, h: 1 }; };
  const r = await fitImage({ bytes: 100, mime: 'image/png', w: 10, h: 10 }, encode, { webp: true, reencode: true });
  assert.equal(r.step, 'lossless');
  assert.deepEqual(steps, ['lossless']);
});
