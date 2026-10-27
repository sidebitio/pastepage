// Images in notes, the pure part: which formats are allowed, what a paste or drop brings in, the steps that make a
// large image fit (with the encoder passed in, so this runs and is tested without a browser), checking a received
// image, and the details line. No DOM here; the browser side is in imageui.js.
import { fmtBytes } from './util.js';

/** The formats an image note may have. SVG is never one of them: it can carry scripts. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Short names for the details line ("PNG 3.2 MB → WebP 640 KB"); not translated. */
const TYPE_NAMES = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

/** File extension per type, for Download. */
export const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * The most raw image bytes one note may carry. The browser does not know the server's MAX_NOTE_BYTES, so this is
 * worked out from its default, 1,500,000, which the server compares with the length of the base64url ciphertext:
 * - the image goes into the JSON payload as base64: 4/3 of the raw bytes;
 * - AES-GCM adds 16 bytes, and the ciphertext is sent as base64url: 4/3 again.
 * So the ciphertext is about 16/9 of the raw image: 800,000 bytes give about 1,422,300 characters, which leaves about
 * 58,000 characters (roughly 43,000 bytes of caption, name and other fields) under 1,500,000. The 1,000,000 that a
 * single 4/3 suggests would come to about 1,780,000 and be refused. A server with a lower MAX_NOTE_BYTES refuses
 * large images with TOO_LARGE, which the page shows like any other error.
 */
export const IMAGE_BUDGET = 800_000;

/** Long-side limits for the scale-down steps, largest first. */
export const SCALE_STEPS = [2560, 1920, 1280];
/** Qualities for the lossy steps, best first; the scale-down steps use the last one. */
export const LOSSY_QUALITIES = [0.92, 0.85];
/** Received images wider or taller than this are not shown (no real screenshot or photo comes near it). */
const MAX_SIDE = 32768;

const isSupported = (type) => IMAGE_TYPES.includes(type);

/**
 * What a paste brings in. An image on the clipboard becomes the note's image: the first one in a supported format
 * (a clipboard often holds one picture in several formats, such as TIFF and PNG). Any text on the clipboard goes into
 * the message box as a normal paste. When the clipboard holds files but none of them is a supported image, the paste
 * is refused (the text, if any, still pastes).
 * @param {{type: string}[]} files the clipboard's files (DataTransfer files)
 * @param {string} text the clipboard's text/plain, '' when none
 * @returns {{image: object|null, refused: boolean, text: string}}
 */
export function clipboardPlan(files, text) {
  const image = files.find((f) => isSupported(f.type)) ?? null;
  return { image, refused: !image && files.length > 0, text: text || '' };
}

/**
 * What a drop brings in: every supported image, in order (each becomes its own note), and how many files were not.
 * @param {{type: string}[]} files the dropped files
 * @returns {{images: object[], refused: number}}
 */
export function dropPlan(files) {
  const images = files.filter((f) => isSupported(f.type));
  return { images, refused: files.length - images.length };
}

/**
 * The format of image bytes, by their first bytes (not by a file name or a claimed type).
 * @param {Uint8Array} b at least the first 12 bytes
 * @returns {string|null} one of IMAGE_TYPES, or null
 */
export function sniffMime(b) {
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  const ascii = (i, s) => at(i, ...[...s].map((c) => c.charCodeAt(0)));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

/**
 * Standard base64 with padding (what a data: URL takes). Works in chunks so large images don't overflow the stack.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Decode standard base64.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- hidden data (location, camera, dates, comments) ---------- */

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * The Orientation tag (1–8) of an EXIF block (a TIFF structure), or 1 when it has none or can't be read.
 * @param {Uint8Array} b
 * @param {number} start where the TIFF header starts
 * @param {number} end where the block ends
 * @returns {number}
 */
function tiffOrientation(b, start, end) {
  if (ascii(b, start, 6) === 'Exif\0\0') start += 6; // some WebP writers keep JPEG's prefix
  if (end - start < 8) return 1;
  const le = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!le && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return 1;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : u16be(b, o));
  const ifd = start + (le ? u32le(b, start + 4) : u32be(b, start + 4));
  if (ifd + 2 > end) return 1;
  for (let i = 0, n = u16(ifd); i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}

/** A JPEG APP1 EXIF segment that holds only an Orientation tag (big-endian TIFF, one IFD, one entry). */
const orientationApp1 = (v) => Uint8Array.from([
  0xff, 0xe1, 0, 34, ...[...'Exif'].map((c) => c.charCodeAt(0)), 0, 0,
  0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0, 0, 0, 0, 0,
]);

/**
 * JPEG: keep the picture, its tables, the JFIF header (APP0), the colour profile (APP2 ICC_PROFILE) and the Adobe
 * colour marker (APP14); drop EXIF and XMP (APP1), IPTC (APP13), other APP segments and comments, and anything after
 * the end of the picture (phones put extra pictures there, each with its own EXIF). A rotated photo gets back an EXIF
 * block with only its Orientation, so it still shows upright.
 */
function stripJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out = [b.subarray(0, 2)];
  let insertAt = 1;
  let orientation = 1;
  let p = 2;
  while (p + 1 < b.length) {
    if (b[p] !== 0xff) return null;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; } // fill byte
    if (m === 0xd9) {
      out.push(b.subarray(p, p + 2));
      if (orientation !== 1) out.splice(insertAt, 0, orientationApp1(orientation));
      return concat(out);
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
    if (p + 4 > b.length) return null;
    const end = p + 2 + u16be(b, p + 2);
    if (end > b.length || end < p + 4) return null;
    if (m === 0xda) {
      // Start of scan: the compressed picture follows, up to the next marker (0xFF followed by neither 0x00 nor RSTn).
      let q = end;
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] !== 0 && !(b[q + 1] >= 0xd0 && b[q + 1] <= 0xd7))) q++;
      if (q + 1 >= b.length) return null;
      out.push(b.subarray(p, q));
      p = q;
      continue;
    }
    let keep = true;
    if (m === 0xe1 && ascii(b, p + 4, 6) === 'Exif\0\0') orientation = tiffOrientation(b, p + 10, end);
    if (m >= 0xe0 && m <= 0xef) keep = m === 0xe0 || m === 0xee || (m === 0xe2 && ascii(b, p + 4, 12) === 'ICC_PROFILE\0');
    if (m === 0xfe) keep = false;
    if (keep) out.push(b.subarray(p, end));
    if (m === 0xe0 && out.length === 2) insertAt = 2; // EXIF goes after a leading JFIF header
    p = end;
  }
  return null;
}

/** PNG chunks that carry text, EXIF or a date; everything else (pixels, colour profile, gamma, …) stays. */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(b) {
  if (sniffMime(b.subarray(0, 16)) !== 'image/png') return null;
  const out = [b.subarray(0, 8)];
  let orientation = 1;
  for (let p = 8; p + 12 <= b.length;) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    const end = p + 12 + len;
    if (end > b.length) return null;
    if (type === 'eXIf') orientation = tiffOrientation(b, p + 8, p + 8 + len);
    if (!PNG_DROP.has(type)) out.push(b.subarray(p, end));
    if (type === 'IEND') return { bytes: concat(out), reencode: orientation !== 1 };
    p = end;
  }
  return null;
}

function stripWebp(b) {
  if (sniffMime(b.subarray(0, 16)) !== 'image/webp') return null;
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
  const chunks = [];
  let orientation = 1;
  for (let p = 12; p + 8 <= riffEnd;) {
    const type = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    if (p + 8 + size > riffEnd) return null;
    const end = Math.min(riffEnd, p + 8 + size + (size & 1));
    if (type === 'EXIF') orientation = tiffOrientation(b, p + 8, p + 8 + size);
    else if (type !== 'XMP ') chunks.push(b.slice(p, end));
    p = end;
  }
  // VP8X flags: 0x08 says there is EXIF, 0x04 says there is XMP.
  if (chunks[0] && ascii(chunks[0], 0, 4) === 'VP8X') chunks[0][8] &= ~0x0c;
  const body = concat(chunks);
  const head = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return { bytes: concat([head, body]), reencode: orientation !== 1 };
}

/** GIF: drop comments and application blocks other than the animation loop count (NETSCAPE2.0, ANIMEXTS1.0). */
function stripGif(b) {
  if (b.length < 13 || sniffMime(b.subarray(0, 16)) !== 'image/gif') return null;
  const table = (flags) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  const blocks = (q) => { // skip data sub-blocks; returns the index after the terminator, or -1
    while (q < b.length) { const n = b[q]; q += 1 + n; if (n === 0) return q; }
    return -1;
  };
  let p = 13 + table(b[10]);
  const out = [b.subarray(0, p)];
  while (p < b.length) {
    if (b[p] === 0x3b) { out.push(b.subarray(p, p + 1)); return concat(out); }
    let end;
    let keep = true;
    if (b[p] === 0x21) {
      end = blocks(p + 2);
      if (b[p + 1] === 0xfe) keep = false;
      if (b[p + 1] === 0xff) keep = ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(ascii(b, p + 3, 11));
    } else if (b[p] === 0x2c && p + 10 < b.length) {
      end = blocks(p + 10 + table(b[p + 9]) + 1);
    } else return null;
    if (end < 0) return null;
    if (keep) out.push(b.subarray(p, end));
    p = end;
  }
  return null;
}

/**
 * Remove the hidden data a picture file can carry (GPS location, camera, dates, names, comments) without touching
 * the picture itself. Only images sent as they are need this: a converted image is drawn on a canvas and written
 * anew, which carries none of it.
 * @param {Uint8Array} bytes the file
 * @param {string} mime its type, from sniffMime
 * @returns {{bytes: Uint8Array, reencode: boolean}|null} the cleaned file; reencode is true when it can't be sent as
 *   it is without showing sideways (a PNG or WebP with an EXIF rotation). null when the file can't be read as its
 *   format.
 */
export function stripMetadata(bytes, mime) {
  if (mime === 'image/jpeg') { const out = stripJpeg(bytes); return out && { bytes: out, reencode: false }; }
  if (mime === 'image/png') return stripPng(bytes);
  if (mime === 'image/webp') return stripWebp(bytes);
  if (mime === 'image/gif') { const out = stripGif(bytes); return out && { bytes: out, reencode: false }; }
  return null;
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isSide = (n) => Number.isSafeInteger(n) && n > 0 && n <= MAX_SIDE;

/**
 * Check a received image (from someone else's payload) and return a clean copy, or null when anything is off:
 * a type outside IMAGE_TYPES, data that is not base64 or not in the format it claims, or a width or height that is
 * not a positive whole number. The size is worked out from the data; a missing or odd orig becomes the sent image.
 * @param {*} img the payload's image field
 * @returns {{mime: string, data: string, w: number, h: number, bytes: number, orig: {mime: string, bytes: number}}|null}
 */
export function validImage(img) {
  if (img === null || typeof img !== 'object' || Array.isArray(img)) return null;
  const { mime, data, w, h } = img;
  if (!isSupported(mime) || typeof data !== 'string' || data.length < 8 || !B64_RE.test(data)) return null;
  if (!isSide(w) || !isSide(h)) return null;
  if (sniffMime(fromBase64(data.slice(0, 16))) !== mime) return null;
  const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  const o = img.orig;
  const orig = o && typeof o === 'object' && isSupported(o.mime) && Number.isSafeInteger(o.bytes) && o.bytes > 0
    ? { mime: o.mime, bytes: o.bytes } : { mime, bytes };
  return { mime, data, w, h, bytes, orig };
}

/**
 * The steps that make an image smaller, in the order they are tried. Each is one encode of the whole picture.
 * - lossless: WebP at quality 1. In Chrome and Firefox that is WebP's lossless mode; where the browser can't write
 *   WebP at all (Safari), PNG.
 * - lossy: WebP (or JPEG without WebP) at 0.92, then 0.85.
 * - scale: at most 2560, 1920 and 1280 px on the long side, at 0.85; a step at or above the long side is skipped.
 * @param {{w: number, h: number}} src the picture's size
 * @param {boolean} webp whether the browser can encode WebP
 * @returns {{name: string, type: string, quality: number, maxSide: number|null}[]}
 */
export function ladder({ w, h }, webp) {
  const lossy = webp ? 'image/webp' : 'image/jpeg';
  const steps = [{ name: 'lossless', type: webp ? 'image/webp' : 'image/png', quality: 1, maxSide: null }];
  for (const q of LOSSY_QUALITIES) steps.push({ name: `lossy-${q}`, type: lossy, quality: q, maxSide: null });
  const q = LOSSY_QUALITIES[LOSSY_QUALITIES.length - 1];
  for (const side of SCALE_STEPS) if (side < Math.max(w, h)) steps.push({ name: `scale-${side}`, type: lossy, quality: q, maxSide: side });
  return steps;
}

/**
 * Make an image fit the budget, stopping at the first step that fits: the original bytes unchanged when they fit,
 * else each step of ladder() in turn. A GIF is never converted (that would lose its animation): it is sent as it is
 * or refused.
 * @param {{bytes: number, mime: string, w: number, h: number}} src the original
 * @param {(step: {name: string, type: string, quality: number, maxSide: number|null}) =>
 *   Promise<{bytes: number, mime: string, w: number, h: number}|null>} encode does one step; null when it can't
 * @param {{webp: boolean, budget?: number, reencode?: boolean}} opts webp: whether the browser can encode WebP;
 *   reencode: skip sending the original (see stripMetadata)
 * @returns {Promise<{ok: true, step: string, out: object|null}|{ok: false, reason: 'gif'|'tooLarge'}>} out is the
 *   encoder's result, or null for the original
 */
export async function fitImage(src, encode, { webp, budget = IMAGE_BUDGET, reencode = false }) {
  if (!reencode && src.bytes <= budget) return { ok: true, step: 'original', out: null };
  if (src.mime === 'image/gif') return { ok: false, reason: 'gif' };
  for (const step of ladder(src, webp)) {
    const out = await encode(step);
    if (out && out.bytes <= budget) return { ok: true, step: step.name, out };
  }
  return { ok: false, reason: 'tooLarge' };
}

/**
 * The type name of an image type, e.g. "PNG".
 * @param {string} mime one of IMAGE_TYPES
 * @returns {string}
 */
export const typeName = (mime) => TYPE_NAMES[mime] ?? '';

/**
 * The details line: "PNG 640 KB" for an image sent as it was, "PNG 3.2 MB → WebP 640 KB" for a converted one.
 * @param {{mime: string, bytes: number, orig: {mime: string, bytes: number}}} img
 * @param {(key: string, vars?: object) => string} t translate function (for the sizes)
 * @returns {string}
 */
export function imageDetails(img, t) {
  const sent = `${typeName(img.mime)} ${fmtBytes(img.bytes, t)}`;
  const o = img.orig;
  if (!o || (o.mime === img.mime && o.bytes === img.bytes)) return sent;
  return `${typeName(o.mime)} ${fmtBytes(o.bytes, t)} → ${sent}`;
}

/**
 * The image as a data: URL, built only from a type in IMAGE_TYPES and checked base64 (see validImage).
 * @param {{mime: string, data: string}} img
 * @returns {string}
 */
export const dataUrl = (img) => `data:${IMAGE_TYPES.find((m) => m === img.mime)};base64,${img.data}`;
