// Feed rendering: one card per note, kept in a Map(seq -> element) so each batch only builds and
// highlights the notes that are new, and removes the ones that are gone. Existing notes are never re-highlighted.
import { lineCount, noteList } from './state.js';
import { currentLocale, formatTime } from './i18n.js';
import { button, capName, detectHighlight, displayText, fmtBytes, langName, make } from './util.js';
import {
  pinButton, reactionRow, relabelReactions, relabelReply, renderPinned, resetExtras, setLabel, setPinned, updateReactions,
  updateReply,
} from './extras.js';

/** Notes longer than this many characters are shown without highlighting. */
export const HIGHLIGHT_LIMIT = 200000;
/** Notes with more lines than this are cut off behind "Show all N lines". */
export const COLLAPSE_LINES = 28;

const te = new TextEncoder();
/** seq -> { el, sig } for the notes currently in the DOM. */
const cards = new Map();
/** False until the first render after resetFeed(); notes in that first render are not "fresh". */
let primed = false;
/** The language the cards on screen are written in; when it changes, renderFeed relabels them. */
let feedLocale = null;
/** Note card -> function that writes its texts again in the current language (never touching its code). */
const relabelers = new WeakMap();

/**
 * Fill a <code> element with the text, highlighted when possible, and return the language label: highlight.js's
 * name for the language, or '' for plain text (shown as t('note.plain'), so it follows the UI language).
 * The label only ever comes from highlight.js's own language names, never from the (untrusted) payload.
 */
function highlight(code, text, lang) {
  const plain = () => { code.textContent = text; return ''; };
  const hljs = globalThis.hljs;
  if (!hljs || lang === 'plaintext' || text.length > HIGHLIGHT_LIMIT) return plain();
  try {
    if (lang === 'auto' && /^\s*[[{]/.test(text)) {
      try { JSON.parse(text); lang = 'json'; } catch { /* not JSON */ }
    }
    if (lang === 'auto') {
      const r = detectHighlight(hljs, text);
      if (!r) return plain();
      code.innerHTML = r.value; // highlight.js escapes the text it wraps
      return langName(r.language);
    }
    const label = langName(lang);
    if (!label) return plain();
    code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    return label;
  } catch {
    return plain();
  }
}

/** The card head: who, meta and the action buttons container. */
function cardHead(el) {
  const head = make('div', 'note-head');
  const who = make('span', 'who');
  const meta = make('span', 'meta');
  const actions = make('div', 'note-actions');
  head.append(who, meta, actions);
  el.append(head);
  return { who, meta, actions };
}

/** Sender's own view of a burn note: masked (or revealed in this tab), the waiting or read line, Delete. */
function burnMine(view, ctx, el, actions) {
  const { t } = ctx;
  const text = ctx.burn.own.get(view.seq);
  const body = make('div', 'burn-body');
  if (view.burn === 'waiting') {
    const shown = text !== undefined && ctx.burn.revealed.has(view.seq);
    const mask = make('p', 'burn-mask' + (shown ? ' shown' : ''), shown ? displayText(text) : '••••••');
    if (!shown) { mask.setAttribute('role', 'img'); mask.setAttribute('aria-label', t('burn.hidden')); }
    body.append(mask);
    if (text !== undefined) {
      // The label changes with the state, like the Pin button; no aria-pressed on top of that.
      actions.append(button('burn-toggle', t(shown ? 'burn.hide' : 'burn.reveal'), () => ctx.actions.revealOwnBurn(view.seq)));
    }
    body.append(make('p', 'note-burn', t('burn.waiting')));
    // Delete only while nobody has read it: once opened, the reader's copy is theirs to close.
    actions.append(button('del', t('note.delete'), () => ctx.actions.del(view.seq)));
  } else {
    body.append(make('p', 'note-burn', view.burnedBy ? t('burn.readBy', { name: capName(view.burnedBy) }) : t('burn.read')));
  }
  el.append(body);
}

/** Someone else's view: a covered card with an open button, the text while the reader has it open, or the read line. */
function burnOther(view, ctx, el, actions) {
  const { t } = ctx;
  const text = ctx.burn.read.get(view.seq);
  const ui = ctx.burn.ui.get(view.seq);
  const body = make('div', 'burn-body');
  if (text !== undefined) {
    const pre = make('pre', 'burn-text', displayText(text)); // Copy below copies the text itself
    body.append(pre, make('p', 'note-burn', t('burn.once')));
    let resetTimer;
    const copy = button('copy', t('note.copy'), async () => {
      if (!(await ctx.actions.copy(text, pre))) return;
      copy.textContent = t('note.copied');
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { copy.textContent = t('note.copy'); }, 1500);
    });
    actions.append(button('burn-close', t('burn.close'), () => ctx.actions.closeBurn(view.seq)), copy);
  } else if (ui?.busy) {
    const open = make('button', 'burn-open', t('burn.opening'));
    open.type = 'button';
    open.disabled = true;
    body.append(open);
  } else if (view.burn === 'burned' || ui?.closed) {
    body.append(make('p', 'note-burn', view.burnedBy ? t('burn.readBy', { name: capName(view.burnedBy) }) : t('burn.read')));
  } else {
    if (!ui?.final) {
      const open = make('button', 'burn-open', t('burn.open'));
      open.type = 'button';
      open.addEventListener('click', () => { open.disabled = true; ctx.actions.openBurn(view.seq); });
      body.append(open);
    }
    if (ui?.msgKey) body.append(make('p', 'note-burn err', t(ui.msgKey)));
  }
  el.append(body);
}

/** Card for a burn-after-reading note. The ciphertext never reaches the page except through the open request. */
function burnEl(view, ctx) {
  const { t } = ctx;
  const el = make('article', 'note burn' + (view.mine ? ' mine' : ''));
  el.dataset.seq = String(view.seq);
  el.tabIndex = -1; // focus lands here when a closed card stays
  const { who, meta, actions } = cardHead(el);
  who.textContent = '🔥 ' + t('burn.title');
  meta.textContent = formatTime(view.ts);
  (view.mine ? burnMine : burnOther)(view, ctx, el, actions);
  return el;
}

/** Card for a note whose payload could not be decrypted or read. */
function brokenEl(view, ctx) {
  const { t } = ctx;
  const el = make('article', 'note broken' + (view.mine ? ' mine' : ''));
  el.dataset.seq = String(view.seq);
  const { who, meta, actions } = cardHead(el);
  who.textContent = t('note.unreadable');
  meta.textContent = formatTime(view.ts);
  actions.append(button('del', t('note.delete'), () => ctx.actions.del(view.seq)));
  el.append(make('p', 'note-broken', t('error.DECRYPT')));
  return el;
}

/**
 * Build the card for one note: name, time, language, line and byte counts, Copy/Wrap/Delete,
 * a line-number gutter and the (highlighted) text. Copy always copies view.text, byte for byte; the code box shows
 * displayText(view.text), so CR and CRLF line endings show as line breaks.
 * @param {object} view a NoteView from state.js
 * @param {{t: Function, myClient: string, actions: object, sendMeta: Function}} ctx
 * @param {object} state the state from state.js (for reply strips and reactions)
 * @returns {HTMLElement}
 */
export function noteEl(view, ctx, state) {
  if (view.burn) return burnEl(view, ctx);
  if (view.broken) return brokenEl(view, ctx);
  const { t } = ctx;
  const el = make('article', 'note' + (view.mine ? ' mine' : '') + (view.pinned ? ' pinned' : ''));
  el.dataset.seq = String(view.seq);
  el.tabIndex = -1; // so a jump from a reply strip or pinned entry can move focus here
  const { who, meta, actions } = cardHead(el);

  const text = view.text;
  const code = make('code');
  const lines = lineCount(text);
  const bytes = te.encode(text).length;
  const label = highlight(code, displayText(text), view.lang || 'auto'); // shown with every line ending as a break
  setLabel(view.seq, label);

  const wrap = button('', '', () => {
    const on = el.classList.toggle('wrap-lines');
    wrap.textContent = t(on ? 'note.noWrap' : 'note.wrap');
  });
  const del = button('del', '', () => ctx.actions.del(view.seq));
  let resetTimer;
  const copy = button('copy', '', async () => {
    if (!(await ctx.actions.copy(text, code))) return;
    copy.textContent = t('note.copied');
    copy.classList.add('done');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { copy.textContent = t('note.copy'); copy.classList.remove('done'); }, 1500);
  });
  const reply = button('reply', '', () => ctx.actions.reply(view.seq));
  actions.append(reply, pinButton(view, ctx), wrap, del, copy);
  el.dataset.replySig = '';
  updateReply(el, state, view, ctx);

  const box = make('div', 'code');
  const gutter = make('div', 'gutter', Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join('\n'));
  gutter.setAttribute('aria-hidden', 'true');
  const pre = make('pre');
  pre.append(code);
  box.append(gutter, pre);
  el.append(box);

  let more = null;
  if (lines > COLLAPSE_LINES) {
    more = button('more', '', () => {
      const on = el.classList.toggle('expanded');
      more.textContent = on ? t('note.showLess') : t('note.showAll', { count: lines });
    });
    el.append(more);
  }

  /** Write the card's texts in the current language: name, meta line, buttons. The code box is left alone. */
  const paint = () => {
    const name = capName(view.name) || t('note.anon');
    who.textContent = view.mine ? t('note.you', { name }) : name;
    meta.replaceChildren(formatTime(view.ts) + ' · ', make('b', '', label || t('note.plain')),
      make('span', 'lines', ' · ' + t('note.lines', { count: lines })), ' · ' + fmtBytes(bytes, t));
    reply.textContent = t('note.reply');
    wrap.textContent = t(el.classList.contains('wrap-lines') ? 'note.noWrap' : 'note.wrap');
    wrap.title = t('note.wrapTitle');
    del.textContent = t('note.delete');
    copy.textContent = t(copy.classList.contains('done') ? 'note.copied' : 'note.copy');
    if (more) more.textContent = el.classList.contains('expanded') ? t('note.showLess') : t('note.showAll', { count: lines });
  };
  paint();
  relabelers.set(el, paint);
  el.append(reactionRow(state, view.seq, ctx));
  return el;
}

/**
 * What about a note can change after it was rendered and needs a rebuilt card. Burn and unreadable cards hold no
 * highlighted code, so they are simply rebuilt, also for a new UI language; a note card is relabelled in place.
 */
const sigOf = (view, ctx, locale) => {
  if (view.broken && !view.burn) return `broken:${locale}`;
  if (!view.burn) return 'note';
  // A card showing the reader's open text is left alone when the note's state changes underneath it.
  if (ctx.burn.read.has(view.seq)) return `burn:${locale}:open:${ctx.burn.sig(view.seq)}`;
  return `burn:${locale}:${view.burn}:${view.burnedBy ?? ''}:${ctx.burn.sig(view.seq)}`;
};

/** After a burn card was rebuilt for the user's own action, put focus back on the matching control. */
function restoreFocus(el, seq, old, ctx) {
  const want = ctx.burn.takeFocus(seq);
  if (!want) return;
  const ae = document.activeElement;
  if (ae && ae !== document.body && !old.contains(ae)) return; // the user moved on; don't steal focus
  let target = null;
  if (want === 'toggle') target = el.querySelector('.burn-toggle');
  else if (want === 'opened') target = el.querySelector('.burn-close') || el.querySelector('.burn-text');
  else if (want === 'open') target = el.querySelector('.burn-open:not(:disabled)');
  if (!target) { target = el; }
  if (target === el) el.tabIndex = -1;
  else if (target.classList.contains('burn-text')) target.tabIndex = 0;
  target.focus();
}

/** Write an existing note card's texts again in the current language (never re-highlights). */
function relabelNoteEl(el, view, state, ctx) {
  relabelers.get(el)?.();
  const pin = el.querySelector('.pin-btn');
  if (pin) setPinned(pin, Boolean(view.pinned), ctx);
  relabelReply(el, state, view, ctx);
  const row = el.querySelector(':scope > .reactions');
  if (row) relabelReactions(row, state, view.seq, ctx);
}

/** Update the parts of an existing card that can change without rebuilding it (never re-highlights). */
function updateNoteEl(el, view, state, ctx) {
  el.classList.toggle('pinned', Boolean(view.pinned));
  const pin = el.querySelector('.pin-btn');
  if (pin && pin.dataset.pinned !== (view.pinned ? '1' : '0')) setPinned(pin, Boolean(view.pinned), ctx);
  updateReply(el, state, view, ctx);
  const row = el.querySelector(':scope > .reactions');
  if (row) updateReactions(row, state, view.seq, ctx);
}

/**
 * Bring the #feed element in line with the state: add new notes in seq order, remove deleted ones,
 * update changed ones. Notes already on screen keep their element and are not highlighted again; after a change
 * of UI language their texts are written again in place.
 * @param {object} state the state from state.js
 * @param {{t: Function, myClient: string, actions: object, sendMeta: Function}} ctx
 * @returns {{first: boolean, added: number, fresh: number, freshName: string, freshBurn: boolean, mine: number, count: number}} first is
 *   true for the first render after resetFeed(); fresh counts new notes from others after that and freshName is
 *   the (capped) name of the latest of them (freshBurn: that latest one is a burn note); mine counts new own notes
 */
export function renderFeed(state, ctx) {
  const feed = document.getElementById('feed');
  const views = noteList(state);
  const keep = new Set(views.map((v) => v.seq));
  // A burn card whose text the reader has open stays until they close it, even if the note was deleted or cleared.
  let orphans = false;
  for (const [seq, card] of cards) {
    if (keep.has(seq)) continue;
    if (card.view && ctx.burn.keep(seq)) { views.push(card.view); orphans = true; } else { card.el.remove(); cards.delete(seq); }
  }
  if (orphans) views.sort((a, b) => a.seq - b.seq);
  const locale = currentLocale();
  const relabel = feedLocale !== null && feedLocale !== locale;
  feedLocale = locale;
  const first = !primed;
  let prev = null;
  let added = 0;
  let fresh = 0;
  let mine = 0;
  let freshName = '';
  let freshBurn = false;
  for (const view of views) {
    const sig = sigOf(view, ctx, locale);
    let card = cards.get(view.seq);
    if (!card) {
      card = { el: noteEl(view, ctx, state), sig, view };
      if (!first && !view.mine) { card.el.classList.add('fresh'); fresh++; freshName = capName(view.name); freshBurn = Boolean(view.burn); }
      if (!first && view.mine) mine++;
      if (prev) prev.after(card.el); else feed.prepend(card.el);
      cards.set(view.seq, card);
      added++;
    } else if (card.sig !== sig) {
      const el = noteEl(view, ctx, state);
      const old = card.el;
      old.replaceWith(el);
      card.el = el;
      card.sig = sig;
      card.view = view;
      if (view.burn) restoreFocus(el, view.seq, old, ctx);
    } else if (keep.has(view.seq)) {
      card.view = view;
      if (relabel) relabelNoteEl(card.el, view, state, ctx);
      updateNoteEl(card.el, view, state, ctx);
    }
    prev = card.el;
  }
  primed = true;
  renderPinned(state, ctx);
  return { first, added, fresh, freshName, freshBurn, mine, count: views.length };
}

/**
 * Empty the feed and forget all cards (call when leaving a room: seq numbers are per session).
 * @returns {void}
 */
export function resetFeed() {
  cards.clear();
  resetExtras();
  primed = false;
  feedLocale = null;
  const feed = document.getElementById('feed');
  if (feed) feed.textContent = '';
}
