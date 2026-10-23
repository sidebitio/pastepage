// Browser state reducer: turns the ordered stream of decrypted wire events into
// a view model (notes, reactions, pins). Pure data in and out: no DOM, no crypto.

/** Allowed reaction emojis, in display order. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];

/** Number of lines shown for a pinned note preview. */
export const PIN_PREVIEW_LINES = 4;

/**
 * Create an empty state.
 * @param {string} myClient - this browser's client id
 * @returns {object} state
 */
export function createState(myClient) {
  return { myClient, lastSeq: -1, notes: new Map(), reactions: new Map(), pins: new Set() };
}

/**
 * Empty a state so a snapshot can be replayed.
 * @param {object} state
 * @returns {void}
 */
export function resetState(state) {
  state.lastSeq = -1;
  state.notes.clear();
  state.reactions.clear();
  state.pins.clear();
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

function applyNote(state, ev, payload) {
  const rec = {
    seq: ev.seq, ts: ev.ts, client: ev.client, name: '', text: '', lang: '',
    replyTo: null, broken: false, burn: null, burnedBy: null, burnedClient: null,
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
    const r = payload.r;
    if (Number.isSafeInteger(r)) {
      const target = state.notes.get(r);
      if (!target || !target.burn) rec.replyTo = r;
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
 * Apply one wire event. Events with seq <= state.lastSeq are ignored.
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
    case 'burn':
      applyNote(state, ev, payload);
      break;
    case 'meta':
      applyMeta(state, ev, payload);
      break;
    case 'delete':
      state.notes.delete(ev.target);
      state.reactions.delete(ev.target);
      state.pins.delete(ev.target);
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
    broken: rec.broken, pinned: state.pins.has(rec.seq), burn: rec.burn, burnedBy: rec.burnedBy,
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
 * @returns {{exists: boolean, name?: string, lang?: string, lines?: number}}
 */
export function replyInfo(state, seq) {
  const rec = state.notes.get(seq);
  if (!rec) return { exists: false };
  return { exists: true, name: rec.name, lang: rec.lang, lines: lineCount(rec.text) };
}
