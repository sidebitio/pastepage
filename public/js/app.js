// Entry point: routing by the URL hash, starting and joining sessions, the room lifecycle (live connection,
// ordered event pipeline, rendering) and the wiring between the feed, the composer and the menus.
import { APP_NAME, SITE_URL, storage } from './brand.js';
import { b64u, decryptJSON, deriveBits, encryptJSON, hex, keysFromBits, unhex } from './crypto.js';
import { ID_RE, newPassword, newSessionId, normId, normPass } from './words.js';
import { parseHash } from './invite.js';
import { applyDom, currentLocale, loadLocale, pickLocale, t } from './i18n.js';
import { applyEvent, createState, noteList, replyInfo, resetState } from './state.js';
import { createPipeline } from './pipeline.js';
import { api, connectLive } from './net.js';
import { renderFeed, resetFeed } from './feed.js';
import { labelOf } from './extras.js';
import {
  clearComposer, getName, getReplyTarget, initComposer, relabelComposer, resetComposer, saveName, setReplyTarget, typedName,
} from './composer.js';
import {
  HOURS, closeMenus, describeExpiry, initMenus, openMenu, relabelMenus, secondsLeft, setExpiry,
} from './menus.js';

const $ = (id) => document.getElementById(id);
const MAX_CREATE_TRIES = 5;
const CLIENT_RE = /^[A-Za-z0-9_-]{6,32}$/;
const KEY_RE = /^[0-9a-f]{128}$/;

/** This tab's client id: random per tab, kept in sessionStorage so a reload keeps it. */
function loadClient() {
  let c = storage.get('sessionStorage', 'client');
  if (!c || !CLIENT_RE.test(c)) {
    c = b64u(crypto.getRandomValues(new Uint8Array(12)));
    storage.set('sessionStorage', 'client', c);
  }
  return c;
}

/** crypto.subtle only exists on https pages and on localhost; without it nothing can be encrypted. */
const INSECURE = !globalThis.crypto?.subtle;
const client = loadClient();
/** The current room, or null. Callbacks from an older room compare against this and do nothing. */
let room = null;
/** Bumped on every navigation, so an async start/join that was overtaken stops. */
let navSeq = 0;
let unseen = 0;

/* ---------- small UI helpers ---------- */

/** The message key for an error code; unknown codes get the generic server error. */
function errKey(code) {
  const key = 'error.' + code;
  return t(key) === key ? 'error.INTERNAL' : key;
}

/** Translate an error code; unknown codes get the generic server error. */
const errText = (code) => t(errKey(code));

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/** Ask for confirmation in the page's own dialog; resolves true for yes. */
function ask(text, yesLabel) {
  return new Promise((resolve) => {
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yesLabel;
    $('confirm').hidden = false;
    $('confirm-no').focus();
    const done = (v) => {
      $('confirm').hidden = true;
      $('confirm-yes').onclick = null;
      $('confirm-no').onclick = null;
      resolve(v);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

/**
 * Copy text to the clipboard, with the old execCommand route as a fallback. If both are blocked,
 * select selectEl's text (when given) and say so.
 */
async function copy(text, selectEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* try the old way */ }
  // The fallback goes through a text box, which turns CRLF and CR line endings into LF. It is only used when the
  // browser blocks the clipboard API; writeText above keeps the text exactly as it is.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (ok) return true;
  if (selectEl) {
    const range = document.createRange();
    range.selectNodeContents(selectEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  toast(t('error.COPY_BLOCKED'));
  return false;
}

let announceTimer;
/** Tell screen readers about a new note: one short message per batch, never the note itself. */
function announce(msg) {
  const el = $('announce');
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = msg; }, 60);
}

/** The error lines under the start and join forms: element id -> function giving the message in the current language. */
const formErrors = new Map();

/** Show an error line (msg: a function returning the text, so it follows a language change) or hide it (msg falsy). */
function setError(id, msg) {
  if (msg) formErrors.set(id, msg); else formErrors.delete(id);
  paintError(id);
}

function paintError(id) {
  const msg = formErrors.get(id);
  $(id).textContent = msg ? msg() : '';
  $(id).hidden = !msg;
}

function setBusy(id, busy, idleKey, busyKey) {
  const el = $(id);
  el.disabled = busy;
  el.dataset.i18n = busy ? busyKey : idleKey; // so applyDom keeps the right label after a language change
  el.textContent = t(el.dataset.i18n);
}

function show(view) {
  closeMenus();
  if (!$('confirm').hidden) $('confirm-no').click(); // a dialog must not stay up over another screen
  if (view !== 'room') $('toast').hidden = true; // room messages don't belong on the other screens
  for (const v of ['start', 'gone', 'room']) $('view-' + v).hidden = v !== view;
}

/* ---------- stored keys ---------- */

function remember(id, bits, pass) {
  storage.set('sessionStorage', 'key:' + id, hex(bits));
  if (pass) storage.set('sessionStorage', 'pass:' + id, pass);
}

function forget(id) {
  storage.del('sessionStorage', 'key:' + id);
  storage.del('sessionStorage', 'pass:' + id);
}

/** The page URL without hash, with the hash set to just the session id (no password). */
const urlFor = (id) => location.pathname + location.search + (id ? '#' + id : '');

/* ---------- views ---------- */

function showStart({ id = '', pass = '', errCode = '' } = {}) {
  leaveRoom();
  const name = getName();
  $('start-name').value = name;
  $('join-name').value = name;
  $('join-id').value = id;
  $('join-pass').value = pass;
  setError('start-err', null);
  setError('join-err', errCode ? () => errText(errCode) : null);
  setBusy('join-go', false, 'join.go', 'join.busy');
  if (INSECURE) {
    setError('start-err', () => errText('INSECURE'));
    $('start-go').disabled = true;
    $('join-go').disabled = true;
  }
  show('start');
  if (id) $(pass ? 'join-go' : 'join-pass').focus();
}

function showGone(r) {
  forget(r.id);
  leaveRoom();
  show('gone');
}

function goHome() {
  history.replaceState(null, '', urlFor(''));
  route();
}

function renderPresence() {
  const el = $('present');
  if (!room) return;
  const online = room.status === 'online';
  el.classList.toggle('off', !online);
  el.textContent = online
    ? t('room.here', { count: Math.max(1, room.present) })
    : t(room.welcomed ? 'room.reconnecting' : 'room.connecting');
}

function enterRoomView() {
  show('room');
  $('join-pass').value = ''; // don't keep the password in the hidden join form
  resetComposer();
  renderPresence();
}

/* ---------- the room ---------- */

/** Leave the current room: stop its connection and clear the feed. Safe to call when not in a room. */
function leaveRoom() {
  clearComposer(); // unsent text, a reply or burn choice never crosses into another session
  if (!room) return;
  room.live?.close();
  room = null;
  burn.clear();
  resetFeed();
  setExpiry(0);
  unseen = 0;
  document.title = APP_NAME;
}

/** Re-render after a batch went through the pipeline: feed, empty hint, scroll and unread count. */
function render(r) {
  const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 260;
  pruneBurn(r.state);
  const res = renderFeed(r.state, ctx);
  // A reply target that was deleted (or cleared away) must not follow into the next note.
  const target = getReplyTarget();
  if (target !== null && !r.state.notes.has(target)) setReplyTarget(null);
  $('empty').hidden = res.count > 0;
  if (res.first || res.mine || (res.added && nearBottom)) window.scrollTo(0, document.body.scrollHeight);
  if (res.fresh) announce(res.freshBurn ? t('burn.new') : t('room.newNote', { name: res.freshName || t('note.anon') }));
  if (res.fresh && document.hidden) {
    unseen += res.fresh;
    document.title = `(${unseen}) ${APP_NAME}`;
  }
}

/**
 * Open a room with the derived bits and connect. With joining, the start view stays until the welcome
 * arrives (the welcome proves the password); otherwise the room view shows at once.
 */
async function openRoom(id, bits, pass, { joining = false, created = null } = {}) {
  const nav = navSeq;
  const { key, auth } = await keysFromBits(bits);
  if (nav !== navSeq) return; // a newer navigation took over while the key was imported
  leaveRoom();
  const state = createState(client);
  const r = {
    id, key, auth, bits, pass, state, joining, welcomed: false, busy: false, status: 'connecting', present: 1, live: null, pipeline: null,
  };
  room = r;
  const alive = () => room === r;
  const pipeline = createPipeline({
    decrypt: (ev) => (ev.kind === 'note' || ev.kind === 'meta' ? decryptJSON(key, ev).catch(() => null) : Promise.resolve(undefined)),
    apply: (ev, payload) => applyEvent(state, ev, payload),
    reset: () => resetState(state),
    onApplied: () => { if (alive()) render(r); },
  });
  r.pipeline = pipeline;
  if (!joining) enterRoomView();
  if (created) setExpiry(created.expires, created.now);
  r.live = connectLive({
    hello: () => ({ id, auth, client, since: -1 }),
    onWelcome: (msg, { reset }) => {
      if (!alive()) return;
      if (!r.welcomed) {
        r.welcomed = true;
        remember(id, bits, pass);
        if (location.hash !== '#' + id) history.replaceState(null, '', urlFor(id)); // the password leaves the address bar
        if (joining) {
          setError('join-err', null); // a "busy" line from an earlier attempt
          enterRoomView();
        }
      }
      r.present = msg.present;
      setExpiry(msg.expires, msg.now);
      pipeline.push(Array.isArray(msg.events) ? msg.events : [], { reset });
    },
    onEvents: (events) => { if (alive()) pipeline.push(Array.isArray(events) ? events : []); },
    onPresence: (n) => { if (!alive()) return; r.present = n; renderPresence(); },
    onSession: (exp) => { if (alive()) setExpiry(exp); },
    onEnded: () => { if (alive()) showGone(r); },
    onError: (code) => {
      if (!alive()) return;
      if (joining && !r.welcomed) return joinFailed(code, id);
      if (code === 'NOT_FOUND') return showGone(r);
      showStart({ id, pass: storage.get('sessionStorage', 'pass:' + id) || '', errCode: code });
    },
    onStatus: (status) => {
      if (!alive()) return;
      if (joining && !r.welcomed) {
        // Turned away because the session or server is at a limit: say so and keep trying (connectLive backs off).
        // Once that has happened, a later failed attempt counts as busy too: the server was reachable a moment ago.
        // Any other failure to connect ends the join.
        if (status === 'busy') r.busy = true;
        if (!r.busy) return joinFailed('CONNECTION', id);
        setError('join-err', () => errText('BUSY'));
        return;
      }
      r.status = status;
      renderPresence();
    },
  });
}

/** A join attempt failed before the welcome: back to the join form with the reason. */
function joinFailed(code, id) {
  leaveRoom();
  stripPass(id);
  setBusy('join-go', false, 'join.go', 'join.busy');
  setError('join-err', () => errText(code));
}

/** If the address bar holds "#id/pass", keep only "#id": a reload must not retry, and the password must not stay in history. */
function stripPass(id) {
  if (parseHash(location.hash)?.pass) history.replaceState(null, '', urlFor(id));
}

/** Join with a typed or linked session name and password. */
async function join(rawId, rawPass) {
  const id = normId(rawId);
  const pass = normPass(rawPass);
  if (!ID_RE.test(id)) { setError('join-err', () => t('join.badId')); return; }
  const nav = ++navSeq;
  setError('join-err', null);
  setBusy('join-go', true, 'join.go', 'join.busy');
  try {
    const bits = await deriveBits(pass, id);
    if (nav !== navSeq) return;
    await openRoom(id, bits, pass, { joining: true });
  } catch (err) {
    console.error(err);
    if (nav !== navSeq) return;
    joinFailed(INSECURE ? 'INSECURE' : 'INTERNAL', id);
  }
}

/** Start a new session with a random name and password; retries a taken name a few times. */
async function create() {
  const nav = ++navSeq;
  setError('start-err', null);
  setBusy('start-go', true, 'start.go', 'start.busy');
  const name = saveName($('start-name').value);
  $('start-name').value = name;
  const hours = Number($('start-hours').value) || 24;
  const pass = newPassword();
  let id;
  let bits;
  let res;
  let failed = null;
  try {
    for (let i = 0; i < MAX_CREATE_TRIES; i++) {
      id = newSessionId();
      bits = await deriveBits(pass, id);
      const { auth } = await keysFromBits(bits);
      res = await api('create', { id, auth, client, hours });
      if (res.data?.error !== 'TAKEN') break;
    }
  } catch (err) {
    console.error(err);
    failed = INSECURE ? 'INSECURE' : 'INTERNAL';
  } finally {
    setBusy('start-go', false, 'start.go', 'start.busy');
  }
  if (nav !== navSeq) return;
  if (failed) { setError('start-err', () => errText(failed)); return; }
  if (res.status !== 200) {
    const code = res.data?.error;
    setError('start-err', () => errText(code));
    return;
  }
  remember(id, bits, pass);
  history.pushState(null, '', urlFor(id));
  await openRoom(id, bits, pass, { created: res.data });
  if (room?.id === id) openMenu('invite');
}

/* ---------- actions inside the room ---------- */

/** POST an action for room r. Resolves the response data, or null after showing the error. */
async function post(r, action, extra = {}) {
  const res = await api(action, { id: r.id, auth: r.auth, client, ...extra });
  if (room !== r) return null;
  if (res.status === 200) return res.data;
  const code = res.data?.error;
  if (code === 'NOT_FOUND') showGone(r);
  else toast(errText(code));
  return null;
}

/** Encrypt a payload and add it to the current room as kind note, burn or meta. Resolves the response ({seq}) or null. */
async function sendEncrypted(kind, payload) {
  const r = room;
  if (!r) return null;
  const { iv, ct } = await encryptJSON(r.key, payload);
  if (room !== r) return null;
  return post(r, 'add', { kind, iv, ct });
}

async function deleteNote(seq) {
  const r = room;
  if (r && await post(r, 'delete', { target: seq })) toast(t('toast.deleted'));
}

async function changeExpiry(hours) {
  const r = room;
  if (!r) return;
  const data = await post(r, 'expire', { hours });
  if (!data) return;
  setExpiry(data.expires);
  toast(t('expiry.set', { time: describeExpiry(secondsLeft(), t) })); // the server may have capped the choice
}

async function clearAll() {
  const r = room;
  if (!r) return;
  const count = noteList(r.state).length;
  if (!count) { toast(t('toast.nothingToClear')); return; }
  if (!(await ask(t('confirm.clear', { count }), t('confirm.clearYes')))) return;
  if (room === r && await post(r, 'clear')) toast(t('toast.cleared'));
}

async function endSession() {
  const r = room;
  if (!r) return;
  if (!(await ask(t('confirm.end'), t('confirm.endYes')))) return;
  if (room === r && await post(r, 'end')) showGone(r);
}

/** Start a reply to a note: the composer shows who and what is being answered. */
function reply(seq) {
  if (!room) return;
  const info = replyInfo(room.state, seq);
  if (!info.exists) return;
  setReplyTarget(seq, { name: info.name, lang: labelOf(seq), lines: info.lines });
}

/** Switch my reaction on or off for a note. */
async function react(seq, emoji, on) {
  if (!room) return;
  await ctx.sendMeta({ v: 1, m: 'react', note: seq, e: emoji, on, n: typedName(), c: client });
}

/** Pin or unpin a note for everyone. */
async function pin(seq, on) {
  if (!room) return;
  await ctx.sendMeta({ v: 1, m: 'pin', note: seq, on, n: typedName(), c: client });
}

/* ---------- burn after reading ---------- */

/**
 * In-memory only, never stored anywhere: own = the sender's plaintext (seq -> text), read = the text a reader has
 * open (seq -> text), revealed = own notes shown unmasked in this tab, ui = per-card open state ({busy, msgKey, final};
 * msgKey is the translation key of the message shown on the card).
 * All of it is cleared when the room changes.
 */
const burn = {
  own: new Map(),
  read: new Map(),
  revealed: new Set(),
  ui: new Map(),
  /** seq -> which control should get focus after the card is rebuilt for the user's own action. */
  focus: new Map(),
  /** Whether a card with no note behind it must stay: the reader has its text open or an open is in flight. */
  keep(seq) {
    return this.read.has(seq) || Boolean(this.ui.get(seq)?.busy);
  },
  /** Ask for focus on a control once the card is rebuilt. */
  wantFocus(seq, what) {
    this.focus.set(seq, what);
  },
  /** Take (and clear) the pending focus request of a card. */
  takeFocus(seq) {
    const what = this.focus.get(seq);
    this.focus.delete(seq);
    return what;
  },
  /** What about a burn card's local state needs a rebuild when it changes. */
  sig(seq) {
    const u = this.ui.get(seq);
    return [this.own.has(seq), this.revealed.has(seq), this.read.has(seq), u ? `${u.busy ? 1 : 0}${u.final ? 1 : 0}${u.closed ? 1 : 0}${u.msgKey ?? ''}` : ''].join(':');
  },
  clear() {
    this.own.clear(); this.read.clear(); this.revealed.clear(); this.ui.clear(); this.focus.clear();
  },
};

/**
 * Re-render the feed of the current room (burn cards rebuild when their local state changes). It goes through the
 * pipeline so it runs after every pending batch, and never before the first welcome.
 */
function rerender() {
  if (room?.welcomed) room.pipeline.push([]);
}

/** Forget the sender's plaintext of notes that were read or deleted: only an unread note needs it. */
function pruneBurn(state) {
  for (const seq of burn.own.keys()) {
    const n = state.notes.get(seq);
    // A missing note is deleted only if its event was already processed; otherwise the live event is just late.
    if (n ? n.burn !== 'waiting' : seq <= state.lastSeq) { burn.own.delete(seq); burn.revealed.delete(seq); }
  }
  // An open text stays until its reader closes it, even when the note itself was deleted or cleared.
  for (const [seq, u] of burn.ui) if (!state.notes.has(seq) && !u.busy) burn.ui.delete(seq);
}

/** Open someone else's burn note: fetch its ciphertext once, decrypt, show it and tell everyone it was read. */
async function openBurn(seq) {
  const r = room;
  if (!r || burn.read.has(seq) || burn.ui.get(seq)?.busy || burn.ui.get(seq)?.closed) return;
  burn.ui.set(seq, { busy: true });
  rerender();
  const fail = (msgKey, final = false) => {
    burn.ui.set(seq, { msgKey, final });
    burn.wantFocus(seq, final ? 'card' : 'open');
    announce(t(msgKey));
    rerender();
  };
  const res = await api('burn-open', { id: r.id, auth: r.auth, client, target: seq });
  if (room !== r) return;
  if (res.status !== 200) {
    const code = res.data?.error;
    if (code === 'GONE') return fail('burn.gone', true);
    if (code === 'FORBIDDEN') return fail('burn.forbidden', true);
    if (code === 'NOT_FOUND') return showGone(r);
    return fail(errKey(code));
  }
  let text;
  try {
    const p = await decryptJSON(r.key, res.data);
    if (typeof p?.t === 'string') text = p.t;
  } catch { /* handled below */ }
  if (room !== r) return;
  if (text === undefined) return fail('error.DECRYPT', true);
  burn.ui.delete(seq);
  burn.read.set(seq, text);
  burn.wantFocus(seq, 'opened');
  announce(t('burn.opened'));
  rerender();
  await ctx.sendMeta({ v: 1, m: 'burnRead', note: seq, n: typedName(), c: client });
}

/** Close an opened burn note: the text leaves the page and memory. */
function closeBurn(seq) {
  burn.read.delete(seq);
  // If the burned event has not arrived yet, the card must not offer Open again.
  if (room?.state.notes.get(seq)?.burn !== 'burned') burn.ui.set(seq, { closed: true });
  burn.wantFocus(seq, 'card');
  rerender();
}

/** Show or hide the sender's own burn text in this tab. */
function revealOwnBurn(seq) {
  if (burn.revealed.has(seq)) burn.revealed.delete(seq); else burn.revealed.add(seq);
  burn.wantFocus(seq, 'toggle');
  rerender();
}

/** Send a burn note and keep its plaintext in memory under the seq the server gave it. */
async function sendBurn(payload) {
  const r = room;
  const data = await sendEncrypted('burn', payload);
  if (!data) return false;
  if (room === r && Number.isSafeInteger(data.seq)) {
    // The live event may have arrived first; if the note is already burned or gone, there is nothing to keep.
    const n = r.state.notes.get(data.seq);
    if (!n || n.burn === 'waiting') { burn.own.set(data.seq, payload.t); rerender(); }
  }
  return true;
}

/** Shared context for the feed and the composer, so neither imports this module. */
const ctx = {
  t,
  myClient: client,
  actions: {
    copy,
    del: deleteNote,
    reply,
    react,
    pin,
    openBurn,
    closeBurn,
    revealOwnBurn,
  },
  burn,
  /** Encrypt a meta payload (reaction, pin, burn read) and post it as kind 'meta'. */
  sendMeta: async (payload) => { await sendEncrypted('meta', payload); },
  /** Encrypt a note payload and post it as kind 'note' (or 'burn'); resolves true on success. */
  sendNote: async (payload, { burn: isBurn = false } = {}) => (isBurn ? sendBurn(payload) : (await sendEncrypted('note', payload)) !== null),
};

/* ---------- routing ---------- */

/**
 * Route by the hash: "#id/pass" joins, "#id" with a stored key reconnects, "#id" without one shows
 * the join form, anything else shows the start screen.
 */
function route() {
  const nav = ++navSeq;
  const h = parseHash(location.hash);
  if (!h || INSECURE) { showStart(h ? { id: h.id } : {}); return; }
  if (room && room.id === h.id && (room.welcomed || !room.joining)) {
    if (h.pass) history.replaceState(null, '', urlFor(h.id)); // already in this room
    return;
  }
  if (h.pass) {
    showStart({ id: h.id, pass: h.pass });
    join(h.id, h.pass);
    return;
  }
  const saved = storage.get('sessionStorage', 'key:' + h.id);
  if (saved && KEY_RE.test(saved)) {
    openRoom(h.id, unhex(saved), storage.get('sessionStorage', 'pass:' + h.id) || '').catch((err) => {
      if (nav === navSeq) { console.error(err); showStart({ id: h.id }); }
    });
    return;
  }
  showStart({ id: h.id });
}

/* ---------- UI language ---------- */

let localeSeq = 0;

/** A language was chosen in a picker: load it, save it if it loaded, then show the page in it. When choices overlap, the last wins. */
async function changeLocale(locale) {
  const seq = ++localeSeq;
  try { await loadLocale(locale); } catch (err) { console.error(err); }
  if (seq === localeSeq && currentLocale() === locale) storage.set('localStorage', 'locale', locale);
  if (seq === localeSeq) relocalize();
}

/**
 * Show the page in the current language: <html lang>, the data-i18n texts, error lines, menus, composer and presence,
 * and the feed (its cards are relabelled in place; no note is highlighted again).
 */
function relocalize() {
  document.documentElement.lang = currentLocale();
  applyDom(document);
  for (const id of formErrors.keys()) paintError(id);
  relabelMenus();
  relabelComposer();
  renderPresence();
  rerender();
}

/* ---------- startup ---------- */

function buildStartHours() {
  const sel = $('start-hours');
  for (const h of HOURS) {
    const o = document.createElement('option');
    o.value = String(h);
    o.dataset.i18n = 'hours.' + h;
    sel.append(o);
  }
  sel.value = '24';
}

async function boot() {
  // The saved choice, else the browser's languages, else English. A locale that fails to load on a cold start leaves English (loaded alongside it).
  try { await loadLocale(pickLocale(storage.get('localStorage', 'locale'), navigator.languages)); } catch (err) { console.error(err); }
  document.documentElement.lang = currentLocale();
  buildStartHours();
  applyDom(document);
  initMenus({
    t,
    copy,
    toast,
    getInvite: () => ({
      id: room ? room.id : '',
      pass: room ? room.pass || storage.get('sessionStorage', 'pass:' + room.id) || '' : '',
      base: location.origin + location.pathname,
    }),
    onExpire: changeExpiry,
    onClear: clearAll,
    onEnd: endSession,
    onLocale: changeLocale,
  });
  initComposer(ctx);
  for (const a of document.querySelectorAll('.credit')) a.href = SITE_URL;

  $('start-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('start-go').disabled) create(); });
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('join-go').disabled) return;
    $('join-name').value = saveName($('join-name').value);
    join($('join-id').value, $('join-pass').value);
  });
  $('gone-new').addEventListener('click', goHome);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('confirm').hidden) $('confirm-no').click(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { unseen = 0; document.title = APP_NAME; }
  });
  window.addEventListener('hashchange', route);
  route();
}

boot();
