// Browser state reducer: turns the ordered stream of decrypted wire events into
// a view model (notes, reactions, pins). Pure data in and out: no DOM, no crypto.
import { IMAGE_TYPES, validImage } from './image.js';

/** Allowed reaction emojis, in display order. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

/** Number of lines shown for a pinned note preview. */
export const PIN_PREVIEW_LINES = 4;

/**
 * Create an empty state.
 * @param {string} myClient - this browser's client id
 * @returns {object} state; rolledSeq is the highest seq that rolled off the session (0: none)
 */
export function createState(myClient) {
  return { myClient, lastSeq: -1, rolledSeq: 0, notes: new Map(), reactions: new Map(), pins: new Set() };
}

/**
 * Record the session's rolled-off point: notes with a seq up to it are no longer on the server. Only goes up;
 * anything but a safe integer is ignored.
 * @param {object} state
 * @param {number} rolled
 * @returns {void}
 */
export function setRolled(state, rolled) {
  if (Number.isSafeInteger(rolled) && rolled > state.rolledSeq) state.rolledSeq = rolled;
}

/**
 * Prepare a state for a snapshot. The notes that rolled off the server (seq <= rolled) are not in the snapshot, so
 * they stay, with their reactions and pins; everything else is emptied and comes back from the snapshot, or is gone
 * because it was deleted or cleared meanwhile. A clear in the snapshot still removes the kept notes too, and so does
 * a clear that itself rolled off while the page was away: the welcome's cleared value (the seq of the last clear).
 * @param {object} state
 * @param {number} rolled - the snapshot's rolled-off point; anything but a safe integer counts as 0 (keep nothing)
 * @param {number} [cleared] - the session's last clear; notes up to it are gone; anything but a safe integer counts as 0
 * @returns {void}
 */
export function keepRolled(state, rolled, cleared = 0) {
  const keep = Number.isSafeInteger(rolled) ? rolled : 0;
  const gone = Number.isSafeInteger(cleared) ? cleared : 0;
  const drop = (seq) => seq > keep || seq <= gone;
  state.lastSeq = -1;
  for (const seq of state.notes.keys()) if (drop(seq)) state.notes.delete(seq);
  for (const seq of state.reactions.keys()) if (drop(seq)) state.reactions.delete(seq);
  for (const seq of state.pins) if (drop(seq)) state.pins.delete(seq);
}

/**
 * Take a note out of the state, with its reactions and pin (a delete event, or a rolled-off note deleted on this page).
 * @param {object} state
 * @param {number} seq
 * @returns {void}
 */
export function removeNote(state, seq) {
  state.notes.delete(seq);
  state.reactions.delete(seq);
  state.pins.delete(seq);
}

/**
 * Count the lines of a text; a single trailing line break is not counted. LF, CRLF and a lone CR each end a line.
 * @param {string} text
 * @returns {number} line count ('' gives 0)
 */
export function lineCount(text) {
  if (!text) return 0;
  const parts = text.split(/\r\n?|\n/);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

const isObj = (p) => p !== null && typeof p === 'object';
const isPositive = (n) => Number.isSafeInteger(n) && n > 0;

/**
 * Check the description of the full image that a preview payload carries. A missing or odd orig becomes the full
 * itself, as in validImage.
 * @param {any} f
 * @returns {{mime: string, w: number, h: number, bytes: number, orig: {mime: string, bytes: number}}|null}
 */
function validFull(f) {
  if (!isObj(f) || Array.isArray(f)) return null;
  const { mime, w, h, bytes } = f;
  if (!IMAGE_TYPES.includes(mime) || !isPositive(w) || !isPositive(h) || !isPositive(bytes)) return null;
  const o = f.orig;
  const orig = isObj(o) && IMAGE_TYPES.includes(o.mime) && isPositive(o.bytes) ? { mime: o.mime, bytes: o.bytes } : { mime, bytes };
  return { mime, w, h, bytes, orig };
}

function applyNote(state, ev, payload) {
  const rec = {
    seq: ev.seq, ts: ev.ts, client: ev.client, name: '', text: '', lang: '',
    replyTo: null, broken: false, burn: null, burnedBy: null, burnedClient: null, image: null, preview: false, full: null,
  };
  if (ev.kind === 'burn') {
    rec.text = undefined;
    rec.burn = 'waiting';
  } else if (!isObj(payload) || payload.v !== 1 || typeof payload.t !== 'string'
    || typeof payload.l !== 'string' || typeof payload.n !== 'string') {
    rec.broken = true;
  } else {
    rec.text = payload.t;
    rec.lang = payload.l;
    rec.name = payload.n;
    // An image note carries its caption in t. An image that fails the checks makes the whole note unreadable.
    if (payload.image !== undefined || payload.preview === true) {
      rec.image = validImage(payload.image);
      // A preview payload carries the preview as its image and describes the full image in full.
      if (rec.image && payload.preview === true) {
        rec.full = validFull(payload.full);
        rec.preview = !!rec.full;
        if (!rec.full) rec.image = null;
      }
      if (!rec.image) { rec.broken = true; rec.text = ''; }
    }
    // A reply to an earlier note that is not here (it was deleted or rolled off) keeps replyTo, so the feed can say so.
    const r = payload.r;
    if (Number.isSafeInteger(r)) {
      const target = state.notes.get(r);
      if (target ? !target.burn : r < ev.seq) rec.replyTo = r;
    }
  }
  state.notes.set(ev.seq, rec);
}

function applyMeta(state, ev, payload) {
  if (!isObj(payload) || payload.v !== 1 || !Number.isSafeInteger(payload.note)) return;
  const target = state.notes.get(payload.note);
  if (!target) return;
  switch (payload.m) {
    case 'react': {
      if (target.burn || typeof payload.on !== 'boolean' || typeof payload.n !== 'string') return;
      if (!REACTIONS.includes(payload.e)) return;
      let byEmoji = state.reactions.get(target.seq);
      if (!byEmoji) state.reactions.set(target.seq, (byEmoji = new Map()));
      let byClient = byEmoji.get(payload.e);
      if (!byClient) byEmoji.set(payload.e, (byClient = new Map()));
      byClient.set(ev.client, { name: payload.n, on: payload.on });
      return;
    }
    case 'pin':
      if (target.burn || typeof payload.on !== 'boolean') return;
      if (payload.on) state.pins.add(target.seq); else state.pins.delete(target.seq);
      return;
    case 'burnRead':
      // Only the client the server recorded as the opener may say who read it.
      if (target.burn !== 'burned' || ev.client !== target.burnedClient || typeof payload.n !== 'string') return;
      target.burnedBy = payload.n;
      return;
    default:
  }
}

/**
 * Apply one wire event. Events with seq <= state.lastSeq are ignored. An 'image' event is a note whose payload is
 * either the full one or the preview one (preview: true, with the full image described in full).
 * @param {object} state
 * @param {object} ev - wire event
 * @param {object|null|undefined} payload - decrypted payload; null if decryption
 *   failed, undefined for kinds without ciphertext
 * @returns {void}
 */
export function applyEvent(state, ev, payload) {
  if (!Number.isSafeInteger(ev.seq) || ev.seq <= state.lastSeq) return;
  switch (ev.kind) {
    case 'note':
    case 'image':
    case 'burn':
      applyNote(state, ev, payload);
      break;
    case 'meta':
      applyMeta(state, ev, payload);
      break;
    case 'delete':
      removeNote(state, ev.target);
      break;
    case 'burned': {
      const t = state.notes.get(ev.target);
      if (t && t.burn) { t.burn = 'burned'; t.burnedClient = ev.client; }
      break;
    }
    case 'clear':
      state.notes.clear();
      state.reactions.clear();
      state.pins.clear();
      break;
    default:
  }
  state.lastSeq = ev.seq;
}

function view(state, rec) {
  return {
    seq: rec.seq, ts: rec.ts, client: rec.client, mine: rec.client === state.myClient,
    name: rec.name, text: rec.text, lang: rec.lang, replyTo: rec.replyTo,
    broken: rec.broken, pinned: state.pins.has(rec.seq), burn: rec.burn, burnedBy: rec.burnedBy, image: rec.image,
    preview: rec.preview, full: rec.full ? { ...rec.full, orig: { ...rec.full.orig } } : null,
    rolled: rec.seq <= state.rolledSeq,
  };
}

/**
 * Get one note as a fresh view object.
 * @param {object} state
 * @param {number} seq
 * @returns {object|undefined} NoteView
 */
export function noteView(state, seq) {
  const rec = state.notes.get(seq);
  return rec ? view(state, rec) : undefined;
}

/**
 * All notes in seq order, as fresh views.
 * @param {object} state
 * @returns {object[]} NoteView[]
 */
export function noteList(state) {
  return [...state.notes.values()].sort((a, b) => a.seq - b.seq).map((r) => view(state, r));
}

/**
 * Pinned notes in seq order, as fresh views.
 * @param {object} state
 * @returns {object[]} NoteView[]
 */
export function pinnedList(state) {
  return noteList(state).filter((n) => n.pinned);
}

/**
 * Reactions on a note, in REACTIONS order, only emojis with count above 0.
 * @param {object} state
 * @param {number} seq
 * @returns {{emoji: string, count: number, names: string[], mine: boolean}[]}
 */
export function reactionsFor(state, seq) {
  const byEmoji = state.reactions.get(seq);
  if (!byEmoji) return [];
  const out = [];
  for (const emoji of REACTIONS) {
    const byClient = byEmoji.get(emoji);
    if (!byClient) continue;
    const names = [];
    let mine = false;
    for (const [client, r] of byClient) {
      if (!r.on) continue;
      names.push(r.name);
      if (client === state.myClient) mine = true;
    }
    if (names.length) out.push({ emoji, count: names.length, names, mine });
  }
  return out;
}

/**
 * Info for a reply strip about the note being replied to.
 * @param {object} state
 * @param {number} seq - the replied-to note
 * @returns {{exists: boolean, name?: string, lang?: string, lines?: number, image?: {w: number, h: number}|null}}
 *   image: the picture's size for an image note (for a preview, its full image's size), null otherwise
 */
export function replyInfo(state, seq) {
  const rec = state.notes.get(seq);
  if (!rec) return { exists: false };
  const size = rec.preview ? rec.full : rec.image; // a preview tells the full image's size
  const image = size ? { w: size.w, h: size.h } : null;
  return { exists: true, name: rec.name, lang: rec.lang, lines: lineCount(rec.text), image };
}
