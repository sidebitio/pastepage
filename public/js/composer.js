// Composer: the text box, highlight language, display name and Send. The text is sent exactly as typed
// (no trimming or normalising), and an unedited paste byte for byte, line endings included; paste anywhere on the
// room page fills the box, and Ctrl/Cmd+Enter sends.
import { storage } from './brand.js';
import { lineCount } from './state.js';
import { capName, chooseOutgoing, fmtBytes, langName, NAME_MAX } from './util.js';

/** Everyday highlight languages, listed before all the others. */
const COMMON = ['sql', 'bash', 'php', 'java', 'python', 'json'];

const $ = (id) => document.getElementById(id);
const te = new TextEncoder();
let ctx = null;
let replyTo = null;
/** What the "Replying to" bar shows ({name, lang, lines}), kept so it can be written again in another language. */
let replyShown = null;
/** The Common and All languages groups of the highlight select. */
let groups = null;
let sending = false;
/**
 * The last paste: the clipboard's own text and the box's value right after the paste ({raw, valueAfterPaste}), or
 * null. The box turns CRLF and CR line endings into LF; this keeps what was really pasted.
 */
let lastPaste = null;
/** The clipboard text of a paste into the box, until the browser has inserted it (the input event that follows). */
let pendingPaste = null;

/** The text a note sent now carries: an unedited paste byte for byte, anything else as the box holds it. */
function outgoing() {
  const current = $('compose-text').value;
  return lastPaste ? chooseOutgoing({ ...lastPaste, current }) : current;
}

/** Forget the last paste, so the box's own value is what gets sent. */
function forgetPaste() {
  lastPaste = null;
  pendingPaste = null;
}

/**
 * The saved display name for this browser.
 * @returns {string} '' when none is saved
 */
export function getName() {
  return storage.get('localStorage', 'name') || '';
}

/**
 * Save the display name for this browser: trimmed and cut to NAME_MAX characters.
 * @param {string} raw the typed name
 * @returns {string} the saved name
 */
export function saveName(raw) {
  const name = Array.from(String(raw).trim()).slice(0, NAME_MAX).join('');
  storage.set('localStorage', 'name', name);
  return name;
}

/**
 * The name currently typed in the composer (what a note sent now would carry), cut to NAME_MAX characters.
 * @returns {string}
 */
export function typedName() {
  return Array.from($('compose-name').value.trim()).slice(0, NAME_MAX).join('');
}

/**
 * Set or clear the note the next message replies to, and show or hide the "Replying to" bar.
 * @param {number|null} seq the replied-to note, or null for none
 * @param {{name: string, lang: string, lines: number}} [info] shown in the bar
 * @returns {void}
 */
export function setReplyTarget(seq, info) {
  replyTo = Number.isSafeInteger(seq) ? seq : null;
  replyShown = replyTo === null ? null : info ?? null;
  const bar = $('reply-bar');
  if (!bar) return;
  bar.hidden = replyTo === null;
  paintReply();
  if (replyShown) $('compose-text').focus();
}

/** Write the "Replying to" bar in the current language (empty when not replying). */
function paintReply() {
  const info = replyShown;
  $('reply-text').textContent = info ? ctx.t('reply.to', {
    name: capName(info.name) || ctx.t('note.anon'), lang: info.lang || ctx.t('note.plain'),
    lines: ctx.t('note.lines', { count: info.lines }),
  }) : '';
}

/**
 * The note the next message replies to.
 * @returns {number|null} its seq, or null when not replying
 */
export function getReplyTarget() {
  return replyTo;
}

/**
 * Whether the next note is a burn-after-reading note (the composer's tick box).
 * @returns {boolean}
 */
export function getBurn() {
  return Boolean($('compose-burn')?.checked);
}

/** Untick the burn-after-reading box. */
function clearBurn() {
  const box = $('compose-burn');
  if (box) box.checked = false;
}

function addOption(parent, value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  parent.append(o);
}

/** Detect, Plain text, the common languages, then every other language highlight.js has, by name. */
function buildLanguages() {
  const { t } = ctx;
  const sel = $('compose-lang');
  sel.textContent = '';
  addOption(sel, 'auto', t('compose.detect'));
  addOption(sel, 'plaintext', t('compose.plain'));
  const hljs = globalThis.hljs;
  if (!hljs) return;
  const common = document.createElement('optgroup');
  common.label = t('compose.common');
  for (const l of COMMON) if (langName(l)) addOption(common, l, langName(l));
  const all = document.createElement('optgroup');
  all.label = t('compose.all');
  const rest = hljs.listLanguages().filter((l) => !COMMON.includes(l) && l !== 'plaintext' && langName(l))
    .sort((x, y) => langName(x).localeCompare(langName(y)));
  for (const l of rest) addOption(all, l, langName(l));
  sel.append(common, all);
  groups = { common, all };
}

/** Grow the text box with its content and show the line and byte count. */
function updateSize() {
  const { t } = ctx;
  const ta = $('compose-text');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
  const text = ta.value;
  $('compose-size').textContent = text
    ? t('compose.size', { lines: t('note.lines', { count: lineCount(text) }), size: fmtBytes(te.encode(outgoing()).length, t) })
    : '';
}

async function send(e) {
  e.preventDefault();
  const ta = $('compose-text');
  const shown = ta.value;
  const text = outgoing(); // no trimming; an unedited paste keeps its own line endings
  if (text === '' || sending) return;
  sending = true;
  $('compose-send').disabled = true;
  const name = saveName($('compose-name').value);
  $('compose-name').value = name;
  const payload = { v: 1, t: text, l: $('compose-lang').value || 'auto', n: name, c: ctx.myClient };
  const burn = getBurn();
  if (replyTo !== null && !burn) payload.r = replyTo;
  let ok = false;
  try {
    ok = await ctx.sendNote(payload, { burn });
  } finally {
    sending = false;
    $('compose-send').disabled = false;
  }
  if (!ok) return; // keep the text (and the paste it came from) so nothing is lost
  if (ta.value === shown) {
    ta.value = '';
    forgetPaste();
  }
  setReplyTarget(null);
  clearBurn();
  updateSize();
}

/**
 * Wire up the composer once at startup.
 * @param {{t: Function, myClient: string, actions: object, sendMeta: Function,
 *   sendNote: (payload: object, opts: {burn: boolean}) => Promise<boolean>}} c shared context;
 *   sendNote encrypts and posts a note and resolves true on success
 * @returns {void}
 */
export function initComposer(c) {
  ctx = c;
  $('reply-cancel').addEventListener('click', () => { setReplyTarget(null); $('compose-text').focus(); });
  buildLanguages();
  const ta = $('compose-text');
  $('compose-lang').addEventListener('change', () => storage.set('localStorage', 'hl', $('compose-lang').value));
  $('compose-name').addEventListener('change', () => { $('compose-name').value = saveName($('compose-name').value); });
  // A paste into the box: keep the clipboard's own text. The browser inserts it after this event; the input event
  // that follows records the box's value. Any other input (typing, undo, drop) counts as editing.
  ta.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    lastPaste = null;
    pendingPaste = text || null;
  });
  ta.addEventListener('input', (e) => {
    lastPaste = pendingPaste !== null && e.inputType === 'insertFromPaste' ? { raw: pendingPaste, valueAfterPaste: ta.value } : null;
    pendingPaste = null;
    updateSize();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('compose-form').requestSubmit(); }
  });
  $('compose-form').addEventListener('submit', send);
  // Paste anywhere on the room page goes into the composer.
  document.addEventListener('paste', (e) => {
    if ($('view-room').hidden || !$('confirm').hidden) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    ta.value = text; // the box turns CRLF and CR into LF, so the clipboard's own text is kept for sending
    lastPaste = { raw: text, valueAfterPaste: ta.value };
    pendingPaste = null;
    updateSize();
    ta.focus();
  });
}

/**
 * Write the composer's own texts again in the current language: Detect and Plain text, the group labels, the
 * reply bar and the size label. The text, the chosen highlight language and the language names (highlight.js's
 * own) stay as they are.
 * @returns {void}
 */
export function relabelComposer() {
  if (!ctx) return;
  const { t } = ctx;
  const sel = $('compose-lang');
  const label = (value, key) => {
    const o = sel.querySelector(`:scope > option[value="${value}"]`);
    if (o) o.textContent = t(key);
  };
  label('auto', 'compose.detect');
  label('plaintext', 'compose.plain');
  if (groups) {
    groups.common.label = t('compose.common');
    groups.all.label = t('compose.all');
  }
  paintReply();
  updateSize();
}

/**
 * Empty the composer: text, reply target and size label. Called whenever the room changes, so unsent text
 * never reaches another session.
 * @returns {void}
 */
export function clearComposer() {
  $('compose-text').value = '';
  forgetPaste();
  setReplyTarget(null);
  clearBurn();
  updateSize();
}

/**
 * Prepare the composer for a room: saved name and language, no reply target, size label refreshed.
 * @returns {void}
 */
export function resetComposer() {
  $('compose-name').value = getName();
  const sel = $('compose-lang');
  sel.value = storage.get('localStorage', 'hl') || 'auto';
  if (!sel.value) sel.value = 'auto';
  setReplyTarget(null);
  clearBurn();
  updateSize();
}
