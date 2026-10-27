// Composer: the text box, highlight language, display name, attached images and Send. The text is sent exactly as
// typed (no trimming or normalising), and an unedited paste byte for byte, line endings included; paste anywhere on
// the room page fills the box, and Ctrl/Cmd+Enter sends. An image pasted or dropped anywhere on the room page is
// attached above the box; each attached image is sent as its own note, the first one with the text as its caption.
import { storage } from './brand.js';
import { lineCount } from './state.js';
import { capName, chooseOutgoing, fmtBytes, langName, make, NAME_MAX } from './util.js';
import { clipboardPlan, dataUrl, dropPlan, imageDetails } from './image.js';
import { makePreview, prepareImage, viewerOpen } from './imageui.js';

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

/** At most this many images wait above the box at a time. */
export const MAX_ATTACHED = 10;
/**
 * The images waiting to be sent, in order: {file, image (once prepared), preview (its small preview, null when it
 * couldn't be made), busy}.
 */
let attached = [];
/** Bumped whenever the attachments are thrown away, so a preparation still running for them is dropped. */
let attachGen = 0;
/** Preparations run one after another, so the images keep their order and only one is decoded at a time. */
let prepChain = Promise.resolve();

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
 * @param {{name: string, lang?: string, lines?: number, image?: {w: number, h: number}|null}} [info] shown in the bar
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
  const name = capName(info?.name) || ctx.t('note.anon');
  if (!info) $('reply-text').textContent = '';
  else if (info.image) $('reply-text').textContent = ctx.t('reply.toImage', { name, size: `${info.image.w}×${info.image.h}` });
  else {
    $('reply-text').textContent = ctx.t('reply.to', {
      name, lang: info.lang || ctx.t('note.plain'), lines: ctx.t('note.lines', { count: info.lines }),
    });
  }
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

/* ---------- attached images ---------- */

const preparing = () => attached.some((a) => a.busy);

/** Send is off while a note is being sent or an image is still being prepared. */
function updateSend() {
  $('compose-send').disabled = sending || preparing();
}

/** The message shown when an image can't be attached, per reason from prepareImage. */
const IMAGE_ERRORS = {
  unsupported: 'image.unsupported', unreadable: 'image.unreadable', tooLarge: 'image.tooLarge', gif: 'image.gifTooLarge',
};

/** Draw the strip of attached images above the box: thumbnail, details and a remove button each. */
function paintAttached() {
  const { t } = ctx;
  const strip = $('attach');
  strip.hidden = attached.length === 0;
  strip.replaceChildren(...attached.map((a, i) => {
    const item = make('div', 'attach-item' + (a.busy ? ' busy' : ''));
    if (a.busy) {
      item.append(make('span', 'attach-thumb'), make('span', 'attach-info', t('image.preparing')));
    } else {
      const img = make('img', 'attach-thumb');
      img.src = dataUrl(a.image);
      img.alt = '';
      const info = make('span', 'attach-info');
      info.append(make('b', '', t('image.label')), ` · ${a.image.w}×${a.image.h} · ${imageDetails(a.image, t)}`);
      item.append(img, info);
    }
    const x = make('button', 'attach-remove', '×');
    x.type = 'button';
    x.title = t('image.remove');
    x.setAttribute('aria-label', t('image.remove'));
    x.disabled = sending; // what is being sent can't be taken back
    x.addEventListener('click', () => removeAttached(a, i));
    item.append(x);
    return item;
  }));
  updateSend();
}

/** Remove one attached image (its preparation, if still running, is dropped) and move focus to a sensible place. */
function removeAttached(a, index) {
  attached = attached.filter((x) => x !== a);
  paintAttached();
  const xs = $('attach').querySelectorAll('.attach-remove');
  (xs[Math.min(index, xs.length - 1)] ?? $('compose-text')).focus();
}

/** Throw all attached images away. */
function clearAttached() {
  attachGen++;
  attached = [];
  prepChain = Promise.resolve();
  if (ctx) paintAttached();
}

/**
 * Attach images: each is shown as "Preparing image…" at once and made to fit (see prepareImage) in turn. An image
 * that can't be attached is removed again with a message.
 * @param {Blob[]} files
 */
function attachFiles(files) {
  const room = MAX_ATTACHED - attached.length;
  if (files.length > room) ctx.toast(ctx.t('image.tooMany', { count: MAX_ATTACHED }));
  const gen = attachGen;
  for (const file of files.slice(0, Math.max(0, room))) {
    const a = { file, image: null, preview: null, busy: true };
    attached.push(a);
    prepChain = prepChain.then(async () => {
      if (gen !== attachGen || !attached.includes(a)) return;
      let r;
      try { r = await prepareImage(file); } catch (err) { console.error(err); r = { error: 'unreadable' }; }
      // The preview the server keeps for people who join later; without one, the image is sent as a plain note.
      const preview = r.image ? await makePreview(r.image) : null;
      if (gen !== attachGen || !attached.includes(a)) return; // removed, or the room changed, meanwhile
      a.busy = false;
      a.file = null;
      if (r.error) {
        attached = attached.filter((x) => x !== a);
        ctx.toast(ctx.t(IMAGE_ERRORS[r.error]));
      } else {
        a.image = r.image;
        a.preview = preview;
      }
      paintAttached();
    });
  }
  paintAttached();
}

/** The files on a clipboard: its file list, or the file items where a browser only lists those. */
function clipboardFiles(cd) {
  if (!cd) return [];
  if (cd.files?.length) return [...cd.files];
  return [...(cd.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
}

/* ---------- sending ---------- */

/**
 * The payload the server keeps for people who join later: the note as it is, with the preview as its image, and the
 * full image described. Null without a preview.
 */
function previewPayload(payload, preview) {
  if (!preview || !payload.image) return null;
  const { mime, w, h, bytes, orig } = payload.image;
  return { ...payload, image: preview, preview: true, full: { mime, w, h, bytes, orig: { ...orig } } };
}

async function send(e) {
  e.preventDefault();
  const ta = $('compose-text');
  const shown = ta.value;
  const text = outgoing(); // no trimming; an unedited paste keeps its own line endings
  const images = attached.filter((a) => a.image);
  if ((text === '' && !images.length) || sending || preparing()) return;
  sending = true;
  updateSend();
  const name = saveName($('compose-name').value);
  $('compose-name').value = name;
  const burn = getBurn();
  // Without images, one text note. With images, one note per image in order; the text is the first one's caption,
  // and only the first one is the reply. Captions are never highlighted.
  const notes = images.length
    ? images.map((a, i) => ({ a, payload: { v: 1, t: i === 0 ? text : '', l: 'plaintext', n: name, c: ctx.myClient, image: a.image } }))
    : [{ a: null, payload: { v: 1, t: text, l: $('compose-lang').value || 'auto', n: name, c: ctx.myClient } }];
  if (replyTo !== null && !burn) notes[0].payload.r = replyTo;
  let ok = true;
  try {
    for (const [i, { a, payload }] of notes.entries()) {
      ok = await ctx.sendNote(payload, { burn, preview: burn ? null : previewPayload(payload, a?.preview) });
      if (!ok) break; // keep what was not sent (the text too, if the first failed) so nothing is lost
      if (a) attached = attached.filter((x) => x !== a);
      if (i === 0) {
        if (ta.value === shown) {
          ta.value = '';
          forgetPaste();
        }
        setReplyTarget(null);
      }
    }
  } finally {
    sending = false;
    paintAttached();
  }
  if (!ok) return;
  clearBurn();
  updateSize();
}

/**
 * Wire up the composer once at startup.
 * @param {{t: Function, toast: (msg: string) => void, myClient: string, actions: object, sendMeta: Function,
 *   sendNote: (payload: object, opts: {burn: boolean, preview: object|null}) => Promise<boolean>}} c shared context;
 *   sendNote encrypts and posts a note (with preview: as an image note with its preview payload) and resolves true
 *   on success
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
  // A paste without text (only an image, or a refused file) inserts nothing, so the text pasted before it stays as it was.
  ta.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    lastPaste = null;
    pendingPaste = text;
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
  // Paste anywhere on the room page goes into the composer. An image on the clipboard is attached, wherever the paste
  // lands; any text with it is pasted as usual (into the box, it then is the image's caption).
  document.addEventListener('paste', (e) => {
    if ($('view-room').hidden || !$('confirm').hidden || viewerOpen()) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    const inField = tag === 'textarea' || tag === 'input' || tag === 'select';
    const text = e.clipboardData?.getData('text/plain');
    const plan = clipboardPlan(clipboardFiles(e.clipboardData), text);
    if (plan.image) attachFiles([plan.image]);
    else if (plan.refused) ctx.toast(ctx.t('image.unsupported'));
    if (!text && (plan.image || plan.refused)) {
      e.preventDefault();
      if (!inField) ta.focus();
      return;
    }
    if (inField) return;
    if (!text) return;
    e.preventDefault();
    ta.value = text; // the box turns CRLF and CR into LF, so the clipboard's own text is kept for sending
    lastPaste = { raw: text, valueAfterPaste: ta.value };
    pendingPaste = null;
    updateSize();
    ta.focus();
  });
  initDrop(ta);
}

/**
 * Image files dragged over the room page: show where they go, and attach them when dropped. Any drop of files is
 * caught on the room page, so a missed drop never opens the file in place of the session. Text dragged into the
 * box is left to the browser.
 */
function initDrop(ta) {
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const inRoom = () => !$('view-room').hidden;
  const hint = (on) => { $('drop-hint').hidden = !on; };
  document.addEventListener('dragenter', (e) => {
    if (!inRoom() || !hasFiles(e)) return;
    depth++;
    hint($('confirm').hidden && !viewerOpen());
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) hint(false);
  });
  document.addEventListener('dragover', (e) => {
    if (!inRoom() || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = $('confirm').hidden && !viewerOpen() ? 'copy' : 'none';
  });
  document.addEventListener('drop', (e) => {
    if (!inRoom() || !hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    hint(false);
    if (!$('confirm').hidden || viewerOpen()) return;
    const plan = dropPlan([...e.dataTransfer.files]);
    if (plan.refused) ctx.toast(ctx.t('image.unsupported'));
    if (plan.images.length) { attachFiles(plan.images); ta.focus(); }
  });
  document.addEventListener('dragend', () => { depth = 0; hint(false); });
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
  paintAttached();
  updateSize();
}

/**
 * Empty the composer: text, attached images, reply target and size label. Called whenever the room changes, so unsent text
 * never reaches another session.
 * @returns {void}
 */
export function clearComposer() {
  $('compose-text').value = '';
  forgetPaste();
  clearAttached();
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
