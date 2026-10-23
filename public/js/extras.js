// The parts of a note card that change after the note was rendered: the reply strip, the reaction row and the
// pin marker, plus the pinned strip above the feed. None of this touches a card's code body, so reacting to a
// big note never re-highlights it.
import { PIN_PREVIEW_LINES, REACTIONS, lineCount, pinnedList, reactionsFor, replyInfo } from './state.js';
import { currentLocale, formatTime } from './i18n.js';
import { button, capName, displayText, make } from './util.js';

/** An expanded pinned entry shows at most this many lines; the full note is in the feed ("Open in feed"). */
const PIN_EXPANDED_LINES = 200;
const FLASH_MS = 1500;
/** Pending flash-removal timer per note, so a second jump to the same note is not cut short by the first timer. */
const flashTimers = new Map();

/** seq -> highlight.js language name shown on the note's card (what Detect found), or '' for plain text. */
const labels = new Map();
/** seq -> { el, preview, toggle, expanded, relabel } for the entries of the pinned strip. */
const entries = new Map();
/** The language the pinned entries are written in; when it changes, renderPinned relabels them. */
let pinnedLocale = null;
let stripCollapsed = false;
let openPicker = null;
let docWired = false;

/**
 * Remember the language label a card shows, for reply strips, the composer and pinned entries.
 * @param {number} seq the note
 * @param {string} label highlight.js's name, e.g. "SQL", or '' for plain text
 * @returns {void}
 */
export function setLabel(seq, label) { labels.set(seq, label); }
/**
 * The language label of a note. Callers show t('note.plain') for '', so it follows the UI language.
 * @param {number} seq the note
 * @returns {string} highlight.js's name, or '' for plain text or an unknown note
 */
export const labelOf = (seq) => labels.get(seq) ?? '';

/**
 * Scroll a note's card into view, flash it and move keyboard focus to it.
 * @param {number} seq the note to jump to
 * @returns {void}
 */
export function jumpTo(seq) {
  const el = document.querySelector(`#feed [data-seq="${seq}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation if it was already running
  el.classList.add('flash');
  clearTimeout(flashTimers.get(seq));
  flashTimers.set(seq, setTimeout(() => { el.classList.remove('flash'); flashTimers.delete(seq); }, FLASH_MS));
}

/* ---------- reply strip ---------- */

/**
 * What the reply strip depends on: only whether the original still exists (cheap: no line count of the original).
 * @param {object} state the state from state.js
 * @param {object} view the reply's NoteView
 * @returns {string} '' for a note that is not a reply, 'y' when the original exists, 'n' when it is gone
 */
export const replySig = (state, view) => (view.replyTo === null ? '' : state.notes.has(view.replyTo) ? 'y' : 'n');

/**
 * The strip above a reply, or null for a note that is not a reply.
 * @param {object} state the state from state.js
 * @param {object} view the reply's NoteView
 * @param {{t: Function}} ctx shared context
 * @returns {HTMLElement|null} a jump button, or a plain note when the original was deleted
 */
export function replyStrip(state, view, ctx) {
  if (view.replyTo === null) return null;
  const { t } = ctx;
  const info = replyInfo(state, view.replyTo);
  if (!info.exists) {
    const gone = make('div', 'reply-strip gone', t('reply.deleted'));
    return gone;
  }
  const text = t('reply.strip', {
    name: capName(info.name) || t('note.anon'),
    lang: labelOf(view.replyTo) || t('note.plain'),
    lines: t('note.lines', { count: info.lines }),
  });
  const b = button('reply-strip', text, () => jumpTo(view.replyTo));
  b.title = t('reply.jump');
  return b;
}

/**
 * Swap the strip of a card when the original appeared or disappeared.
 * @param {HTMLElement} el the note card
 * @param {object} state the state from state.js
 * @param {object} view the card's NoteView
 * @param {{t: Function}} ctx shared context
 * @returns {void}
 */
export function updateReply(el, state, view, ctx) {
  const sig = replySig(state, view);
  if (el.dataset.replySig === sig) return;
  el.dataset.replySig = sig;
  const old = el.querySelector(':scope > .reply-strip');
  const next = replyStrip(state, view, ctx);
  if (old && next) old.replaceWith(next);
  else if (old) old.remove();
  else if (next) el.querySelector(':scope > .note-head').after(next);
}

/**
 * Rebuild a card's reply strip in the current language.
 * @param {HTMLElement} el the note card
 * @param {object} state the state from state.js
 * @param {object} view the card's NoteView
 * @param {{t: Function}} ctx shared context
 * @returns {void}
 */
export function relabelReply(el, state, view, ctx) {
  el.dataset.replySig = '-';
  updateReply(el, state, view, ctx);
}

/* ---------- reactions ---------- */

function closePicker() {
  if (!openPicker) return;
  openPicker.pop.hidden = true;
  openPicker.btn.setAttribute('aria-expanded', 'false');
  openPicker = null;
}

function wireDocument() {
  if (docWired) return;
  docWired = true;
  document.addEventListener('click', (e) => { if (openPicker && !openPicker.wrap.contains(e.target)) closePicker(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPicker) { const b = openPicker.btn; closePicker(); b.focus(); }
  });
}

/**
 * What the chips depend on.
 * @param {object} state the state from state.js
 * @param {number} seq the note
 * @returns {string} changes whenever a chip's emoji, count, own state or names change
 */
export const reactionSig = (state, seq) => JSON.stringify(reactionsFor(state, seq).map((r) => [r.emoji, r.count, r.mine, r.names]));

/**
 * Update the chips of a reaction row in place. One chip element is kept per emoji (created the first time
 * that emoji is used, then only hidden when its count drops to zero), so a keyboard user keeps focus.
 * @param {HTMLElement} row the row made by reactionRow
 * @param {object} state the state from state.js
 * @param {number} seq the note
 * @param {{t: Function, actions: object}} ctx shared context
 * @returns {void}
 */
export function updateReactions(row, state, seq, ctx) {
  const sig = reactionSig(state, seq);
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  const { t } = ctx;
  const chips = row.querySelector('.chips');
  const live = new Map(reactionsFor(state, seq).map((r) => [r.emoji, r]));
  for (const emoji of REACTIONS) {
    const r = live.get(emoji);
    let chip = chips.querySelector(`:scope > [data-emoji="${emoji}"]`);
    if (!r) { if (chip) chip.hidden = true; continue; }
    if (!chip) {
      chip = button('chip', '', () => ctx.actions.react(seq, emoji, chip.getAttribute('aria-pressed') !== 'true'));
      chip.dataset.emoji = emoji;
      const later = REACTIONS.slice(REACTIONS.indexOf(emoji) + 1);
      const next = [...chips.children].find((c) => later.includes(c.dataset.emoji));
      chips.insertBefore(chip, next ?? null);
    }
    const names = r.names.map((n) => capName(n) || t('note.anon')).join(', ');
    chip.hidden = false;
    chip.textContent = `${emoji} ${r.count}`;
    chip.title = names;
    chip.setAttribute('aria-pressed', String(r.mine));
    chip.setAttribute('aria-label', t('react.chip', { emoji, count: r.count, names }));
  }
}

/**
 * The reaction row of a card: the chips and the + button with its picker.
 * @param {object} state the state from state.js
 * @param {number} seq the note
 * @param {{t: Function, actions: object}} ctx shared context
 * @returns {HTMLElement}
 */
export function reactionRow(state, seq, ctx) {
  wireDocument();
  const row = make('div', 'reactions');
  row.append(make('div', 'chips'));
  const wrap = make('div', 'react-add');
  const add = button('chip add', '+', () => {
    const wasOpen = openPicker && openPicker.wrap === wrap;
    closePicker();
    if (wasOpen) return;
    pop.hidden = false;
    add.setAttribute('aria-expanded', 'true');
    openPicker = { wrap, pop, btn: add };
  });
  add.setAttribute('aria-expanded', 'false');
  const pop = make('div', 'picker');
  pop.id = `picker-${seq}`;
  add.setAttribute('aria-controls', pop.id);
  pop.hidden = true;
  pop.setAttribute('role', 'group');
  for (const emoji of REACTIONS) {
    const b = button('', emoji, () => {
      closePicker();
      add.focus();
      const mine = reactionsFor(state, seq).find((r) => r.emoji === emoji)?.mine;
      if (!mine) ctx.actions.react(seq, emoji, true);
    });
    b.setAttribute('aria-label', emoji);
    pop.append(b);
  }
  wrap.append(add, pop);
  row.append(wrap);
  labelRow(row, ctx);
  updateReactions(row, state, seq, ctx);
  return row;
}

/** The + button's and the picker's labels. */
function labelRow(row, ctx) {
  const { t } = ctx;
  const add = row.querySelector(':scope > .react-add > .add');
  add.title = t('react.add');
  add.setAttribute('aria-label', t('react.add'));
  row.querySelector(':scope > .react-add > .picker').setAttribute('aria-label', t('react.pick'));
}

/**
 * Write a reaction row's labels again in the current language (the chips keep their elements, so focus stays).
 * @param {HTMLElement} row the row made by reactionRow
 * @param {object} state the state from state.js
 * @param {number} seq the note
 * @param {{t: Function, actions: object}} ctx shared context
 * @returns {void}
 */
export function relabelReactions(row, state, seq, ctx) {
  labelRow(row, ctx);
  row.dataset.sig = '';
  updateReactions(row, state, seq, ctx);
}

/* ---------- pin marker ---------- */

/**
 * The Pin/Unpin button for a card's action row (its label says which).
 * @param {object} view the card's NoteView
 * @param {{t: Function, actions: object}} ctx shared context
 * @returns {HTMLButtonElement}
 */
export function pinButton(view, ctx) {
  const b = button('pin-btn', '', () => ctx.actions.pin(view.seq, b.dataset.pinned !== '1'));
  setPinned(b, view.pinned, ctx);
  return b;
}

/**
 * Update the label of a card's Pin button.
 * @param {HTMLButtonElement} b the button made by pinButton
 * @param {boolean} pinned whether the note is pinned now
 * @param {{t: Function}} ctx shared context
 * @returns {void}
 */
export function setPinned(b, pinned, ctx) {
  b.textContent = ctx.t(pinned ? 'note.unpin' : 'note.pin');
  b.dataset.pinned = pinned ? '1' : '0';
}

/* ---------- pinned strip ---------- */

function entryEl(view, ctx) {
  const { t } = ctx;
  const el = make('article', 'pin-entry');
  const head = button('pin-head', '', () => jumpTo(view.seq));
  const who = make('b', '');
  const meta = make('span', 'meta');
  head.append(who, meta);
  const preview = make('pre', 'pin-text');
  const total = lineCount(view.text);
  // Only the lines that can ever be shown are split out of the text (with CR and CRLF line endings as breaks too).
  const lines = displayText(view.text).split('\n', PIN_EXPANDED_LINES);
  const cut = total > PIN_EXPANDED_LINES;
  const entry = { el, preview, expanded: false, toggle: null, feedLink: null, relabel: null };
  const paint = () => {
    preview.textContent = lines.slice(0, entry.expanded ? PIN_EXPANDED_LINES : PIN_PREVIEW_LINES).join('\n');
    if (entry.toggle) {
      entry.toggle.textContent = entry.expanded ? t('note.showLess')
        : t(cut ? 'pin.showFirst' : 'note.showAll', { count: cut ? PIN_EXPANDED_LINES : total });
      entry.toggle.setAttribute('aria-expanded', String(entry.expanded));
    }
    if (entry.feedLink) entry.feedLink.hidden = !entry.expanded;
  };
  /** Write the entry's texts in the current language. */
  entry.relabel = () => {
    head.title = t('pin.jump');
    const name = capName(view.name) || t('note.anon');
    who.textContent = view.mine ? t('note.you', { name }) : name;
    meta.textContent = ` · ${labelOf(view.seq) || t('note.plain')} · ${formatTime(view.ts)}`;
    if (entry.feedLink) entry.feedLink.textContent = t('pin.openFeed', { count: total });
    paint();
  };
  el.append(head, preview);
  if (total > PIN_PREVIEW_LINES) {
    entry.toggle = button('more', '', () => { entry.expanded = !entry.expanded; paint(); });
    el.append(entry.toggle);
    if (cut) {
      entry.feedLink = button('more', '', () => jumpTo(view.seq));
      el.append(entry.feedLink);
    }
  }
  entry.relabel();
  return entry;
}

/**
 * Bring the pinned strip in line with the state; entries already shown are kept, not rebuilt (after a change of
 * UI language their texts are written again in place).
 * @param {object} state the state from state.js
 * @param {{t: Function}} ctx shared context
 * @returns {void}
 */
export function renderPinned(state, ctx) {
  const strip = document.getElementById('pinned');
  if (!strip) return;
  const { t } = ctx;
  const views = pinnedList(state).filter((v) => !v.broken && !v.burn);
  strip.hidden = views.length === 0;
  const keep = new Set(views.map((v) => v.seq));
  for (const [seq, e] of entries) if (!keep.has(seq)) { e.el.remove(); entries.delete(seq); }
  const locale = currentLocale();
  if (pinnedLocale !== locale) {
    pinnedLocale = locale;
    for (const e of entries.values()) e.relabel();
  }
  const body = strip.querySelector('.pinned-body');
  const toggle = strip.querySelector('.pinned-toggle');
  strip.querySelector('.pinned-title').textContent = t('pin.title', { count: views.length });
  if (!toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.addEventListener('click', () => { stripCollapsed = !stripCollapsed; applyCollapsed(strip, ctx); });
  }
  let prev = null;
  for (const v of views) {
    let e = entries.get(v.seq);
    if (!e) { e = entryEl(v, ctx); entries.set(v.seq, e); }
    if (prev ? prev.nextElementSibling !== e.el : body.firstElementChild !== e.el) {
      if (prev) prev.after(e.el); else body.prepend(e.el);
    }
    prev = e.el;
  }
  applyCollapsed(strip, ctx);
}

function applyCollapsed(strip, ctx) {
  const toggle = strip.querySelector('.pinned-toggle');
  strip.querySelector('.pinned-body').hidden = stripCollapsed;
  toggle.textContent = ctx.t(stripCollapsed ? 'pin.show' : 'pin.hide');
  toggle.setAttribute('aria-expanded', String(!stripCollapsed));
}

/**
 * Forget everything (leaving a room: seq numbers are per session).
 * @returns {void}
 */
export function resetExtras() {
  labels.clear();
  entries.clear();
  closePicker();
  const strip = document.getElementById('pinned');
  if (strip) { strip.hidden = true; strip.querySelector('.pinned-body').textContent = ''; }
}
