// Images in notes, the browser part: preparing a pasted or dropped image for sending (decode, and the size steps of
// image.js with a canvas encoder) and its small preview, the clickable picture on a card, the full-size viewer, Copy
// (as PNG) and Download. A received image only ever reaches the page as an <img> with a data: URL built by dataUrl().
import { EXTENSIONS, IMAGE_TYPES, dataUrl, fitImage, fromBase64, sniffMime, stripMetadata, toBase64 } from './image.js';

const $ = (id) => document.getElementById(id);

/* ---------- preparing an image for sending ---------- */

let webpCheck = null;

/**
 * Whether this browser's canvas can write WebP. Safari can't: it hands back a PNG instead, so the result's type is
 * what tells. Checked once.
 * @returns {Promise<boolean>}
 */
export function canEncodeWebp() {
  webpCheck ??= new Promise((resolve) => {
    try {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      c.toBlob((b) => resolve(b?.type === 'image/webp'), 'image/webp', 0.8);
    } catch { resolve(false); }
  });
  return webpCheck;
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => {
  try { canvas.toBlob(resolve, type, quality); } catch { resolve(null); }
});

/** A canvas encoder for fitImage: draws the picture at the step's size and encodes it in the step's type. */
function canvasEncoder(bitmap) {
  return async (step) => {
    const long = Math.max(bitmap.width, bitmap.height);
    const scale = step.maxSide && long > step.maxSide ? step.maxSide / long : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    // JPEG has no transparency: without a background, the transparent parts of a screenshot would turn black.
    if (step.type === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.imageSmoothingQuality = 'high';
    g.drawImage(bitmap, 0, 0, w, h);
    const blob = await toBlob(c, step.type, step.quality);
    c.width = 0; // let the browser free the pixels now
    // The type actually written: a browser that can't write the asked type writes PNG instead.
    if (!blob || !IMAGE_TYPES.includes(blob.type)) return null;
    return { bytes: blob.size, mime: blob.type, w, h, blob };
  };
}

/**
 * Turn a pasted or dropped file into the image a note carries, making it fit the budget (see fitImage in image.js).
 * The format comes from the file's first bytes, never from its name or claimed type.
 * @param {Blob} file
 * @returns {Promise<{image: {mime: string, data: string, w: number, h: number, bytes: number,
 *   orig: {mime: string, bytes: number}}}|{error: 'unsupported'|'unreadable'|'tooLarge'|'gif'}>}
 */
export async function prepareImage(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const mime = sniffMime(head);
  if (!mime) return { error: 'unsupported' };
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return { error: 'unreadable' }; }
  try {
    // Hidden data (GPS location, camera, dates) goes before anything else, so it never leaves this page. A file that
    // can't be read as its format is converted instead, which keeps none of it; a GIF that can't is sent as it is.
    const raw = new Uint8Array(await file.arrayBuffer());
    const clean = stripMetadata(raw, mime);
    const kept = clean?.bytes ?? raw;
    const reencode = clean ? clean.reencode : mime !== 'image/gif';
    const src = { bytes: kept.length, mime, w: bitmap.width, h: bitmap.height };
    const r = await fitImage(src, canvasEncoder(bitmap), { webp: await canEncodeWebp(), reencode });
    if (!r.ok) return { error: r.reason };
    const out = r.out ?? { ...src, blob: new Blob([kept], { type: mime }) };
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    if (sniffMime(bytes.subarray(0, 16)) !== out.mime) return { error: 'unreadable' };
    // The details line shows a size change only for a converted image; removing hidden data doesn't count.
    const orig = { mime, bytes: r.out ? file.size : bytes.length };
    return { image: { mime: out.mime, data: toBase64(bytes), w: out.w, h: out.h, bytes: bytes.length, orig } };
  } finally {
    bitmap.close?.();
  }
}

/** A preview is at most this many pixels on its long side. */
export const PREVIEW_SIDE = 480;
/** The preview's lossy quality. */
export const PREVIEW_QUALITY = 0.7;
/**
 * The most bytes a preview may have. The server takes at most 96,000 characters of encrypted preview, about 16/9 of
 * the picture's bytes (base64 in the payload, then base64url of the ciphertext): 50,000 bytes leave room for a caption.
 */
export const PREVIEW_BUDGET = 50_000;
/** Smaller long sides, tried in turn for a busy picture (grass, gravel, noise) whose preview is over the budget. */
const PREVIEW_SMALLER = [360, 240];

/**
 * The small preview of a prepared image that the server keeps for people who join later: at most PREVIEW_SIDE px on
 * the long side, WebP (JPEG where WebP can't be written) at PREVIEW_QUALITY. A GIF gives its first frame, still.
 * A preview over PREVIEW_BUDGET is made smaller (PREVIEW_SMALLER).
 * @param {{mime: string, data: string}} image a prepared (or checked) image
 * @returns {Promise<{mime: string, data: string, w: number, h: number, bytes: number,
 *   orig: {mime: string, bytes: number}}|null>} the same shape as an image; null when it can't be made
 */
export async function makePreview(image) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blobOf(image));
  } catch { return null; }
  try {
    const type = (await canEncodeWebp()) ? 'image/webp' : 'image/jpeg';
    const encode = canvasEncoder(bitmap);
    let out = null;
    for (const maxSide of [PREVIEW_SIDE, ...PREVIEW_SMALLER]) {
      out = await encode({ type, quality: PREVIEW_QUALITY, maxSide });
      if (!out || out.bytes <= PREVIEW_BUDGET) break;
    }
    if (!out) return null;
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    if (sniffMime(bytes.subarray(0, 16)) !== out.mime) return null;
    return { mime: out.mime, data: toBase64(bytes), w: out.w, h: out.h, bytes: bytes.length, orig: { mime: out.mime, bytes: bytes.length } };
  } catch {
    return null;
  } finally {
    bitmap.close?.();
  }
}

/* ---------- the picture on a card ---------- */

/**
 * The picture as a button that opens the viewer. Its width and height are set from the image, so the card has its
 * final size before the picture is decoded (the feed scrolls to the bottom right after a render).
 * @param {{mime: string, data: string, w: number, h: number}} image a checked image
 * @param {string} alt the text alternative
 * @param {string} title the button's tooltip
 * @param {{w: number, h: number}} [size] the size to show it at (a preview is shown at its full image's size)
 * @returns {HTMLButtonElement}
 */
export function imageButton(image, alt, title, size = image) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'img-open';
  b.title = title;
  const img = document.createElement('img');
  img.src = dataUrl(image);
  img.alt = alt;
  img.width = size.w;
  img.height = size.h;
  img.decoding = 'async';
  b.style.setProperty('--w', String(size.w));
  b.style.setProperty('--h', String(size.h));
  b.append(img);
  b.addEventListener('click', () => openViewer(image, alt, b));
  return b;
}

/* ---------- the viewer ---------- */

let viewerFrom = null;
let viewerWired = false;

/**
 * Whether the full-size viewer is open.
 * @returns {boolean}
 */
export const viewerOpen = () => !$('viewer').hidden;

/** Show the Actual size button only when the picture is shown smaller than it is. */
function fitCheck() {
  const img = $('viewer-img');
  const btn = $('viewer-actual');
  const actual = img.classList.contains('actual');
  btn.setAttribute('aria-pressed', String(actual));
  btn.hidden = !actual && img.clientWidth >= img.naturalWidth && img.clientHeight >= img.naturalHeight;
  $('viewer').classList.toggle('zoomable', !btn.hidden);
}

function toggleActual() {
  const img = $('viewer-img');
  if ($('viewer-actual').hidden) return;
  img.classList.toggle('actual');
  fitCheck();
}

function wireViewer() {
  if (viewerWired) return;
  viewerWired = true;
  const v = $('viewer');
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer-actual').addEventListener('click', toggleActual);
  $('viewer-img').addEventListener('click', toggleActual);
  $('viewer-img').addEventListener('load', fitCheck);
  // A click on the dark area around the picture closes the viewer.
  v.addEventListener('click', (e) => { if (e.target === v || e.target === $('viewer-scroll')) closeViewer(); });
  v.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeViewer(); return; }
    if (e.key !== 'Tab') return;
    // Keep focus inside the dialog.
    const stops = [...v.querySelectorAll('button')].filter((b) => !b.hidden);
    const i = stops.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : (i + 1) % stops.length;
    e.preventDefault();
    stops[next].focus();
  });
  window.addEventListener('resize', () => { if (viewerOpen()) fitCheck(); });
}

/**
 * Open the full-size viewer on an image: the whole picture fits the window (never enlarged); Actual size, or a click
 * on the picture, shows it pixel for pixel and the viewer scrolls. Esc, the close button or a click beside the
 * picture closes it, and focus goes back to from.
 * @param {{mime: string, data: string}} image a checked image
 * @param {string} alt the text alternative
 * @param {HTMLElement} from the control that opened it
 * @returns {void}
 */
export function openViewer(image, alt, from) {
  wireViewer();
  const img = $('viewer-img');
  img.classList.remove('actual');
  img.alt = alt;
  img.src = dataUrl(image);
  viewerFrom = from;
  $('viewer').hidden = false;
  document.documentElement.classList.add('viewer-open');
  $('viewer-scroll').scrollTo(0, 0);
  fitCheck();
  $('viewer-close').focus();
}

/**
 * Close the viewer (if open) and put focus back where it was opened from.
 * @returns {void}
 */
export function closeViewer() {
  if (!$('viewer') || !viewerOpen()) return;
  $('viewer').hidden = true;
  $('viewer-img').removeAttribute('src');
  document.documentElement.classList.remove('viewer-open');
  const from = viewerFrom;
  viewerFrom = null;
  if (from?.isConnected) from.focus();
}

/* ---------- copy and download ---------- */

const blobOf = (image) => new Blob([fromBase64(image.data)], { type: image.mime });

/** The image as a PNG blob (the clipboard's most widely supported image type). */
async function pngBlob(image) {
  const blob = blobOf(image);
  if (image.mime === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const png = await toBlob(c, 'image/png');
  if (!png) throw new Error('PNG encoding failed');
  return png;
}

/**
 * Put the image on the clipboard as PNG. The write starts at once, inside the click (Safari requires that), with
 * the PNG made while it waits.
 * @param {{mime: string, data: string}} image a checked image
 * @returns {Promise<boolean>} false when the browser doesn't allow it
 */
export async function copyImage(image) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(image) })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save the image as it was sent.
 * @param {{mime: string, data: string}} image a checked image
 * @param {string} base the file name without extension, e.g. "pastepage-12-dancing-apes-7"
 * @returns {void}
 */
export function downloadImage(image, base) {
  const url = URL.createObjectURL(blobOf(image));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}.${EXTENSIONS[image.mime]}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
