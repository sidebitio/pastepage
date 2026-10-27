// Entry point: routing by the URL hash, the draft page (where a visit lands; its first Send or Invite makes the
// session), joining sessions, the room lifecycle (live connection, ordered event pipeline, rendering) and the wiring
// between the feed, the composer and the menus.
import { APP_NAME, SITE_URL, storage } from './brand.js';
import { b64u, decryptJSON, deriveBits, encryptJSON, hex, keysFromBits, unhex } from './crypto.js';
import { ID_RE, newPassword, newSessionId, normId, normPass } from './words.js';
import { inviteLink, parseHash, parseJoinInput } from './invite.js';
import { applyDom, currentLocale, loadLocale, pickLocale, t } from './i18n.js';
import { applyEvent, createState, keepRolled, noteList, removeNote, replyInfo, setRolled } from './state.js';
import { createPipeline } from './pipeline.js';
import { api, connectLive } from './net.js';
import { renderFeed, resetFeed } from './feed.js';
import { labelOf } from './extras.js';
import { validImage } from './image.js';
import { closeViewer, copyImage, downloadImage } from './imageui.js';
import * as local from './localstore.js';
import {
  clearComposer, getReplyTarget, initComposer, relabelComposer, resetComposer, setReplyTarget, typedName,
} from './composer.js';
import {
  HOURS, closeMenus, describeExpiry, initMenus, openMenu, relabelMenus, secondsLeft, setDraftHours, setExpiry,
} from './menus.js';

const $ = (id) => document.getElementById(id);
const MAX_CREATE_TRIES = 5;
const CLIENT_RE = /^[A-Za-z0-9_-]{6,32}$/;
const KEY_RE = /^[0-9a-f]{128}$/;
/**
 * The server's limit on an image note's encrypted preview (MAX_PREVIEW_BYTES) until the welcome says what it is (the
 * default); a longer one isn't sent.
 */
const PREVIEW_MAX = 96000;
/** How long the page waits for the local image store to open. Some Safari versions never answer at all. */
const STORE_WAIT_MS = 1500;

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
/**
 * True on the draft page: the room page shown before any session exists (where a visit lands). Its first Send, or
 * Invite, makes the session; until then nothing leaves the browser.
 */
let draftMode = false;
/** The expiry chosen on the draft page for the session it will make, in hours. */
let draftHours = 24;
/** The session being made from the draft page, so a Send of several images or a second click waits for the same one. */
let creating = null;
/** Set while a join's key is being derived (before its room exists): Send and Invite must not make a session then. */
let joinPending = null;

let storeOpening = null;
/**
 * The local image store (see localstore.js), opened once per page: null where IndexedDB can't be used, or when it
 * doesn't answer within STORE_WAIT_MS. Nothing waits for it before the first render.
 * @returns {Promise<IDBDatabase|null>}
 */
function localStore() {
  storeOpening ??= Promise.race([
    local.openStore(),
    new Promise((resolve) => { setTimeout(() => resolve(null), STORE_WAIT_MS); }),
  ]).catch(() => null);
  return storeOpening;
}

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

/**
 * Keep --composer-h at the message box's full height (padding and safe area included), so the toast and the notice
 * sit just above it however tall it grows. Hidden (another screen), it reports 0: then the CSS default holds.
 */
function followComposer() {
  const box = document.querySelector('.composer');
  const root = document.documentElement.style;
  const update = () => {
    const h = box.getBoundingClientRect().height;
    if (h > 0) root.setProperty('--composer-h', h + 'px');
    else root.removeProperty('--composer-h');
  };
  if ('ResizeObserver' in window) new ResizeObserver(update).observe(box);
  update();
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

/** The error lines of the Join panel and the draft page: element id -> function giving the message in the current language. */
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
  if (view !== 'room') { $('toast').hidden = true; $('notice').hidden = true; } // room messages don't belong on the other screens
  for (const v of ['gone', 'room']) $('view-' + v).hidden = v !== view;
}

/* ---------- stored keys ---------- */

function remember(id, bits, pass) {
  storage.set('sessionStorage', 'key:' + id, hex(bits));
  if (pass) storage.set('sessionStorage', 'pass:' + id, pass);
}

function forget(id) {
  storage.del('sessionStorage', 'key:' + id);
  storage.del('sessionStorage', 'pass:' + id);
  storage.del('sessionStorage', 'rolled:' + id);
}

/** True for a room this page may act in: one it made or reconnected to, or a join the server has welcomed. */
const ready = (r) => Boolean(r) && (r.welcomed || !r.joining);

/** The page URL without hash, with the hash set to just the session id (no password). */
const urlFor = (id) => location.pathname + location.search + (id ? '#' + id : '');

/* ---------- views ---------- */

/**
 * The draft page: the room page with no session yet, the cursor in the message box. With an id (a link without a
 * stored key, or a join to retry), the Join panel opens filled in. Staying on the draft page keeps what is typed.
 */
function showDraft({ id = '', pass = '', errCode = '', openJoin = false } = {}) {
  const staying = draftMode;
  leaveRoom(staying);
  show('room');
  applyDraft(true);
  if (!staying) resetComposer();
  renderUsage();
  $('empty').hidden = false;
  $('join-id').value = id;
  $('join-pass').value = pass;
  setError('join-err', errCode ? () => errText(errCode) : null);
  setBusy('join-go', false, 'join.go', 'join.busy');
  setError('draft-err', INSECURE ? () => errText('INSECURE') : null);
  if (id || openJoin) {
    openMenu('join');
    $(!id ? 'join-id' : pass ? 'join-go' : 'join-pass').focus();
  } else {
    $('compose-text').focus();
  }
}

/** Switch the room page between the draft page and a session: Join, the empty-page text, the expiry pill, presence. */
function applyDraft(on) {
  draftMode = on;
  $('join-wrap').hidden = !on;
  $('draft-empty').hidden = !on;
  $('room-empty').hidden = on;
  setDraftHours(on ? draftHours : 0);
  renderPresence();
}

function showGone(r) {
  forget(r.id);
  r.gone = true;
  // The session is gone for sure (ended, or not found with key bits it had accepted; a failed join never comes here):
  // its images on this computer go too. They could no longer be read anyway.
  queueLocal(r, async () => local.deleteSession(await localStore(), r.id));
  leaveRoom();
  show('gone');
}

function goHome() {
  history.replaceState(null, '', urlFor(''));
  route();
}

/** From a room that is still on, to the draft page for a new one. Its key stays stored, so Back returns to it. */
function startNew() {
  history.pushState(null, '', urlFor(''));
  route();
}

function renderPresence() {
  const el = $('present');
  el.hidden = draftMode;
  if (!room) return;
  const online = room.status === 'online';
  el.classList.toggle('off', !online);
  el.textContent = online
    ? t('room.here', { count: Math.max(1, room.present) })
    : t(room.welcomed ? 'room.reconnecting' : 'room.connecting');
}

/** Show the room. keepComposer: the draft page carried on into this session, so its box stays exactly as it was. */
function enterRoomView(keepComposer = false) {
  show('room');
  applyDraft(false);
  $('join-pass').value = ''; // don't keep the password in the hidden join form
  if (!keepComposer) resetComposer();
  renderPresence();
  renderUsage();
}

/** The gauge under the top bar: how full the session is (room.used, tenths of a percent), shown from 1%. */
function renderUsage() {
  const el = $('usage');
  const used = room ? room.used : 0;
  el.hidden = used < 10;
  el.firstElementChild.style.width = `${Math.min(100, used / 10)}%`;
  el.title = used < 10 ? '' : t('usage.title', { pct: Math.min(100, Math.floor(used / 10)) });
}

/**
 * The session in room r has started rolling over: say so once, in a notice that stays until closed. Once per session
 * per tab (remembered in sessionStorage, so a reload doesn't bring it back).
 */
function noticeRolled(r) {
  const key = 'rolled:' + r.id;
  if (r.noticed || storage.get('sessionStorage', key)) return;
  r.noticed = true; // also when sessionStorage is blocked
  storage.set('sessionStorage', key, '1');
  $('notice').hidden = false;
}

/* ---------- the room ---------- */

/** Run a local-store task for room r after the ones queued before it, so a delete never overtakes an earlier save. */
function queueLocal(r, task) {
  r.io = r.io.then(task).catch((err) => console.error(err));
}

/** A new expiry time (Unix seconds) for room r's session: kept for new local copies, and set on the saved ones. */
function noteExpiry(r, expires) {
  if (!Number.isSafeInteger(expires) || expires === r.expires) return;
  r.expires = expires;
  queueLocal(r, async () => { const loc = await r.local; if (loc) await local.setExpiry(loc.store, r.id, expires); });
}

/** The local store and its key for room r, once the first welcome brought the server's share; null without either. */
async function openLocal(bits, share) {
  if (typeof share !== 'string' || !share) return null;
  const store = await localStore();
  if (!store) return null;
  try {
    return { store, key: await local.deriveStorageKey(bits.subarray(0, 32), share) };
  } catch { return null; }
}

/**
 * Tell the server this tab has an image's full version saved. A receipt can be lost (the socket was down, or looked
 * open but was already dead), so every welcome sends them all again (r.saved); the server ignores the ones it no
 * longer waits for.
 */
function sendGot(r, seq) {
  if (room === r) r.live?.send({ type: 'got', seq });
}

/**
 * Keep an image note's full payload: in memory for this room, and saved on this computer. With receipt, the server
 * is told once it is saved, so it can forget the full; nothing saved (no storage), no receipt, and the server keeps it.
 */
function keepFull(r, seq, payload, receipt) {
  r.fulls.set(seq, payload);
  queueLocal(r, async () => {
    const loc = await r.local;
    // Nothing is saved for a session that is over, nor for a note that rolled off meanwhile (a reload can't show it).
    if (!loc || r.gone || seq <= r.state.rolledSeq) return;
    const saved = await local.saveImage(loc.store, loc.key, { sessionId: r.id, seq, payload, expires: r.expires });
    // A note deleted or cleared while it was being saved is no longer in r.fulls: its record goes next, no receipt.
    if (saved && receipt && r.fulls.has(seq)) {
      r.saved.add(seq);
      sendGot(r, seq);
    }
  });
}

/** Forget the kept full payloads that a delete or clear removed (seq passes the test), here and on this computer. */
function dropFulls(r, gone, task) {
  for (const seq of r.fulls.keys()) if (gone(seq)) r.fulls.delete(seq);
  for (const seq of r.saved) if (gone(seq)) r.saved.delete(seq);
  queueLocal(r, async () => { const loc = await r.local; if (loc) await task(loc.store); });
}

/**
 * The payload of an image event, the best one there is:
 * - the sender's own: the full it sent (the server may only hold the preview);
 * - one this tab already has;
 * - the full the event carries (the server holds it until everyone here has saved it): decrypted, then saved;
 * - the full saved on this computer earlier;
 * - else the preview.
 */
async function imagePayload(r, ev) {
  if (!Number.isSafeInteger(ev.seq)) return null;
  if (ev.full === false) r.saved.delete(ev.seq); // the server no longer holds the full: no receipt is needed again
  const own = ev.client === client && typeof ev.piv === 'string' ? r.sent.get(ev.piv) : undefined;
  if (own) {
    r.sent.delete(ev.piv);
    keepFull(r, ev.seq, own, false);
    return own;
  }
  const kept = r.fulls.get(ev.seq);
  if (kept) return kept;
  if (typeof ev.iv === 'string' && typeof ev.ct === 'string') {
    const full = await decryptJSON(r.key, ev).catch(() => null);
    if (full) {
      keepFull(r, ev.seq, full, true);
      return full;
    }
  }
  const loc = await r.local;
  const saved = loc ? await local.loadImage(loc.store, loc.key, r.id, ev.seq) : null;
  if (saved) {
    r.fulls.set(ev.seq, saved);
    return saved;
  }
  if (typeof ev.piv !== 'string' || typeof ev.pct !== 'string') return null;
  return decryptJSON(r.key, { iv: ev.piv, ct: ev.pct }).catch(() => null);
}

/**
 * Leave the current room: stop its connection and clear the feed. Safe to call when not in a room. Unsent text,
 * images, a reply or burn choice never cross into another session; only keepComposer (going from the draft page to
 * its own new session, or joining from it) leaves them in the box.
 */
function leaveRoom(keepComposer = false) {
  if (!keepComposer) clearComposer();
  closeViewer();
  $('notice').hidden = true;
  $('invite-bar').hidden = true;
  if (!room) return;
  room.live?.close();
  room = null;
  renderUsage();
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
  // From the draft page to the session it made, what is typed stays: it is what is being sent. A join from the draft
  // page keeps it only until the join succeeds (a failed join leaves the draft as it was); once in the joined
  // session, the box is empty. Anything else (Back to an older room, say) starts with an empty box.
  const keep = draftMode && (created !== null || joining);
  leaveRoom(keep);
  const state = createState(client);
  let haveLocal;
  const r = {
    id, key, auth, bits, pass, state, joining, welcomed: false, busy: false, status: 'connecting', present: 1, used: 0,
    live: null, pipeline: null, gone: false,
    /** True once this page showed the notice that the session rolls over. */
    noticed: false,
    /** The session's expiry (Unix seconds), for local copies. */
    expires: 0,
    /** The server's share, from the first welcome; with the session key it makes the local store's key. */
    share: null,
    /** Resolves {store, key} for the local image store after the first welcome, or null when it can't be used. */
    local: new Promise((resolve) => { haveLocal = resolve; }),
    /** This room's local-store tasks, in order. */
    io: Promise.resolve(),
    /** Image notes this tab is sending: the preview's iv -> the full payload, until its event comes back. */
    sent: new Map(),
    /** Full image payloads this tab has: seq -> payload. */
    fulls: new Map(),
    /** Image notes whose full this tab saved and confirmed: seqs. Confirmed again on every welcome. */
    saved: new Set(),
    /** The server's limit on an encrypted preview, from the welcome. */
    previewMax: PREVIEW_MAX,
  };
  room = r;
  const alive = () => room === r;
  const pipeline = createPipeline({
    decrypt: (ev) => {
      if (ev.kind === 'image') return imagePayload(r, ev);
      return ev.kind === 'note' || ev.kind === 'meta' ? decryptJSON(key, ev).catch(() => null) : Promise.resolve(undefined);
    },
    apply: (ev, payload) => {
      applyEvent(state, ev, payload);
      if (ev.kind === 'delete' && Number.isSafeInteger(ev.target)) {
        dropFulls(r, (seq) => seq === ev.target, (store) => local.deleteImage(store, id, ev.target));
      } else if (ev.kind === 'clear' && Number.isSafeInteger(ev.seq)) {
        dropFulls(r, (seq) => seq <= ev.seq, (store) => local.deleteUpTo(store, id, ev.seq));
      }
    },
    // A snapshot: notes that rolled off the server stay, unless a clear removed them (its event may have rolled off
    // too: cleared says so). Their full images go from memory and this computer, as on a clear event.
    reset: (rolled, cleared) => {
      keepRolled(state, rolled, cleared);
      if (Number.isSafeInteger(cleared) && cleared > 0) {
        dropFulls(r, (seq) => seq <= cleared, (store) => local.deleteUpTo(store, id, cleared));
      }
    },
    onApplied: () => { if (alive()) render(r); },
  });
  r.pipeline = pipeline;
  if (!joining) enterRoomView(keep);
  if (created) {
    setExpiry(created.expires, created.now);
    noteExpiry(r, created.expires);
  }
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
          clearComposer(); // the draft's text was not meant for this session: it starts with an empty box
          enterRoomView();
        }
      }
      if (r.share === null) {
        // The local store's key is made once, before the welcome's events go into the pipeline that needs it.
        r.share = typeof msg.share === 'string' ? msg.share : '';
        haveLocal(openLocal(bits, r.share));
      }
      r.present = msg.present;
      if (Number.isSafeInteger(msg.maxPreview) && msg.maxPreview > 0) r.previewMax = msg.maxPreview;
      setExpiry(msg.expires, msg.now);
      noteExpiry(r, msg.expires);
      for (const seq of r.saved) sendGot(r, seq);
      pipeline.push(Array.isArray(msg.events) ? msg.events : [], { reset, rolled: msg.rolled, cleared: msg.cleared });
    },
    onEvents: (events) => { if (alive()) pipeline.push(Array.isArray(events) ? events : []); },
    onUsage: (used, rolled) => {
      if (!alive()) return;
      if (Number.isSafeInteger(used)) r.used = used;
      const before = state.rolledSeq;
      setRolled(state, rolled);
      renderUsage();
      if (state.rolledSeq > before) {
        rerender(); // shade the notes that just rolled off
        // A reload can't show them again, so their saved copies go; this page keeps showing them from memory.
        const upTo = state.rolledSeq;
        for (const seq of r.saved) if (seq <= upTo) r.saved.delete(seq);
        queueLocal(r, async () => { const loc = await r.local; if (loc) await local.deleteUpTo(loc.store, id, upTo); });
      }
      if (state.rolledSeq > 0) noticeRolled(r);
    },
    onPresence: (n) => { if (!alive()) return; r.present = n; renderPresence(); },
    onSession: (exp) => {
      if (!alive()) return;
      setExpiry(exp);
      noteExpiry(r, exp);
    },
    onEnded: () => { if (alive()) showGone(r); },
    onError: (code) => {
      if (!alive()) return;
      if (joining && !r.welcomed) return joinFailed(code, id);
      if (code === 'NOT_FOUND') return showGone(r);
      showDraft({ id, pass: storage.get('sessionStorage', 'pass:' + id) || '', errCode: code });
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

/** A join attempt failed before the welcome: back to the Join panel with the reason; the draft's text stays. */
function joinFailed(code, id) {
  leaveRoom(true);
  stripPass(id);
  setBusy('join-go', false, 'join.go', 'join.busy');
  setError('join-err', () => errText(code));
  openMenu('join');
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
  const pending = {};
  joinPending = pending;
  try {
    const bits = await deriveBits(pass, id);
    if (nav !== navSeq) return;
    await openRoom(id, bits, pass, { joining: true });
  } catch (err) {
    console.error(err);
    if (nav !== navSeq) return;
    joinFailed(INSECURE ? 'INSECURE' : 'INTERNAL', id);
  } finally {
    // By now the room exists (and is refused until welcomed), the join failed, or another navigation took over.
    if (joinPending === pending) joinPending = null;
  }
}

/**
 * Make a session for the draft page, with a random name and password (a taken name is retried a few times), and open
 * it, keeping what is in the message box. Resolves the new room, or null after saying why it failed.
 */
async function createSession() {
  const nav = ++navSeq;
  setError('draft-err', null);
  const hours = draftHours;
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
  }
  if (nav !== navSeq || !draftMode) return null;
  if (!failed && res.status !== 200) failed = res.data?.error;
  if (failed) {
    setError('draft-err', () => errText(failed));
    toast(errText(failed));
    return null;
  }
  remember(id, bits, pass);
  history.replaceState(null, '', urlFor(id)); // Back from here goes where the draft page came from, not to an empty draft
  await openRoom(id, bits, pass, { created: res.data });
  return room?.id === id ? room : null;
}

/**
 * The room to send to: the current one, or on the draft page a new session (made once, however many notes wait for
 * it). Null while a join is still being checked, or when making the session failed (it said why).
 */
function ensureRoom() {
  if (ready(room)) return Promise.resolve(room);
  if (room || joinPending) { toast(t('join.busy')); return Promise.resolve(null); }
  if (!draftMode) return Promise.resolve(null);
  creating ??= createSession().finally(() => { creating = null; });
  return creating;
}

/** The invite link of the current room, with the password when this tab has it. */
function roomLink() {
  const pass = room.pass || storage.get('sessionStorage', 'pass:' + room.id) || '';
  return inviteLink(location.origin + location.pathname, room.id, pass);
}

/** After the first Send made the session: the link to share, in a bar above the notes that never takes the focus. */
function showInviteBar() {
  if (!room) return;
  $('bar-link').textContent = roomLink(); // textContent: never parsed as HTML
  $('invite-bar').hidden = false;
}

/* ---------- actions inside the room ---------- */

/**
 * POST an action for room r. Resolves the response data, or null after showing the error. handle(code), when given,
 * may take care of an error code itself (returning true), instead of the toast.
 */
async function post(r, action, extra = {}, handle = null) {
  const res = await api(action, { id: r.id, auth: r.auth, client, ...extra });
  if (room !== r) return null;
  if (res.status === 200) return res.data;
  const code = res.data?.error;
  if (code === 'NOT_FOUND') showGone(r);
  else if (!handle?.(code)) toast(errText(code));
  return null;
}

/**
 * Encrypt a payload and add it to the current room as kind note, burn or meta. With a preview payload (a note with
 * an image), as kind image: the full and the preview, encrypted separately; the server passes the full on to those
 * here now and keeps the preview for later. A preview over the server's limit is left out, and the note goes as a
 * plain note. Resolves the response ({seq}) or null.
 */
async function sendEncrypted(kind, payload, preview = null) {
  const r = room;
  if (!r) return null;
  const { iv, ct } = await encryptJSON(r.key, payload);
  const p = preview ? await encryptJSON(r.key, preview) : null;
  if (room !== r) return null;
  if (!p || p.ct.length > r.previewMax) return post(r, 'add', { kind, iv, ct });
  // Its event can come back before this request finishes; the full is found by the preview's iv.
  r.sent.set(p.iv, payload);
  const data = await post(r, 'add', { kind: 'image', iv, ct, piv: p.iv, pct: p.ct });
  if (!data) r.sent.delete(p.iv);
  return data;
}

async function deleteNote(seq) {
  const r = room;
  if (!r) return;
  // A note that rolled off is no longer on the server, which answers GONE: it is only on this page, so it goes from
  // here, quietly (other pages keep their copy until they reload, so "deleted for everyone" would not be true).
  const rolledOff = (code) => {
    if (code !== 'GONE' || seq > r.state.rolledSeq) return false;
    removeNote(r.state, seq);
    dropFulls(r, (s) => s === seq, (store) => local.deleteImage(store, r.id, seq));
    rerender();
    return true;
  };
  if (await post(r, 'delete', { target: seq }, rolledOff)) toast(t('toast.deleted'));
}

async function changeExpiry(hours) {
  const r = room;
  if (!r) return;
  const data = await post(r, 'expire', { hours });
  if (!data) return;
  setExpiry(data.expires);
  noteExpiry(r, data.expires);
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
  setReplyTarget(seq, { name: info.name, lang: labelOf(seq), lines: info.lines, image: info.image });
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
 * In-memory only, never stored anywhere: own = the sender's plaintext (seq -> {text, image}), read = what a reader
 * has open (seq -> {text, image}; image is null for a text note), revealed = own notes shown unmasked in this tab, ui = per-card open state ({busy, msgKey, final};
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
  let opened;
  try {
    const p = await decryptJSON(r.key, res.data);
    // An image burn note carries its image like any image note; one that fails the checks is unreadable.
    const image = p?.image === undefined ? null : validImage(p.image);
    if (typeof p?.t === 'string' && (image || p.image === undefined)) opened = { text: p.t, image };
  } catch { /* handled below */ }
  if (room !== r) return;
  if (opened === undefined) return fail('error.DECRYPT', true);
  burn.ui.delete(seq);
  burn.read.set(seq, opened);
  burn.wantFocus(seq, 'opened');
  announce(t('burn.opened'));
  rerender();
  await ctx.sendMeta({ v: 1, m: 'burnRead', note: seq, n: typedName(), c: client });
}

/** Close an opened burn note: the text (or image) leaves the page and memory. */
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
    if (!n || n.burn === 'waiting') { burn.own.set(data.seq, { text: payload.t, image: payload.image ?? null }); rerender(); }
  }
  return true;
}

/** Put an image note's picture on the clipboard (as PNG), or say that the browser blocked it. */
async function copyPicture(image) {
  if (await copyImage(image)) return true;
  toast(t('error.COPY_BLOCKED'));
  return false;
}

/** Save an image note's picture as it was sent, named after the session and the note: pastepage-12-dancing-apes-7.webp. */
function savePicture(image, seq) {
  if (room) downloadImage(image, `pastepage-${room.id}-${seq}`);
}

/** Shared context for the feed and the composer, so neither imports this module. */
const ctx = {
  t,
  toast,
  myClient: client,
  actions: {
    copy,
    copyImage: copyPicture,
    downloadImage: savePicture,
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
  /**
   * Encrypt a note payload and post it as kind 'note' (or 'burn'; with a preview payload, 'image'); resolves true on
   * success. On the draft page, the first one makes the session and then shows its invite bar.
   */
  sendNote: async (payload, { burn: isBurn = false, preview = null } = {}) => {
    const fresh = !room;
    if (!(await ensureRoom())) return false;
    if (fresh) showInviteBar();
    return isBurn ? sendBurn(payload) : (await sendEncrypted('note', payload, preview)) !== null;
  },
};

/* ---------- routing ---------- */

/**
 * Route by the hash: "#id/pass" joins, "#id" with a stored key reconnects, "#id" without one opens the Join panel
 * on the draft page, anything else shows the draft page.
 */
function route() {
  const nav = ++navSeq;
  const h = parseHash(location.hash);
  if (!h || INSECURE) { showDraft(h ? { id: h.id } : {}); return; }
  if (room && room.id === h.id && (room.welcomed || !room.joining)) {
    if (h.pass) history.replaceState(null, '', urlFor(h.id)); // already in this room
    return;
  }
  if (h.pass) {
    showDraft({ id: h.id, pass: h.pass });
    join(h.id, h.pass);
    return;
  }
  const saved = storage.get('sessionStorage', 'key:' + h.id);
  if (saved && KEY_RE.test(saved)) {
    openRoom(h.id, unhex(saved), storage.get('sessionStorage', 'pass:' + h.id) || '').catch((err) => {
      if (nav === navSeq) { console.error(err); showDraft({ id: h.id }); }
    });
    return;
  }
  showDraft({ id: h.id });
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
  renderUsage();
  rerender();
}

/* ---------- startup ---------- */

async function boot() {
  // Images saved on this computer for sessions that have expired meanwhile go first.
  localStore().then((store) => local.sweep(store, Date.now() / 1000)).catch((err) => console.error(err));
  // The saved choice, else the browser's languages, else English. A locale that fails to load on a cold start leaves English (loaded alongside it).
  try { await loadLocale(pickLocale(storage.get('localStorage', 'locale'), navigator.languages)); } catch (err) { console.error(err); }
  document.documentElement.lang = currentLocale();
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
    beforeInvite: () => {
      if (ready(room)) return true;
      if (draftMode) ensureRoom().then((r) => { if (r && room === r) openMenu('invite'); });
      return false;
    },
    onExpire: (hours) => {
      if (ready(room)) { changeExpiry(hours); return; }
      if (room || joinPending) { toast(t('join.busy')); return; } // a join the server hasn't accepted yet
      draftHours = hours;
      setDraftHours(hours);
      // The session may be on its way with the hours chosen before: then it gets these once it exists.
      creating?.then((r) => { if (r && room === r) changeExpiry(hours); });
    },
    onClear: clearAll,
    onEnd: endSession,
    onLocale: changeLocale,
  });
  initComposer(ctx);
  for (const a of document.querySelectorAll('.credit')) a.href = SITE_URL;

  $('join-menu').addEventListener('submit', (e) => {
    e.preventDefault();
    if ($('join-go').disabled || creating) return;
    join($('join-id').value, $('join-pass').value);
  });
  // A whole invite link pasted into the session field fills in both fields.
  $('join-id').addEventListener('input', () => {
    const raw = $('join-id').value;
    if (!/[#/]/.test(raw)) return;
    const h = parseJoinInput(raw);
    if (!h) return;
    $('join-id').value = h.id;
    if (h.pass) $('join-pass').value = h.pass;
    $(h.pass ? 'join-go' : 'join-pass').focus();
  });
  $('draft-join').addEventListener('click', (e) => {
    e.stopPropagation(); // the click must not reach the document, which closes menus
    openMenu('join');
    $('join-id').focus();
  });
  $('bar-copy').addEventListener('click', async () => {
    if (room && (await copy(roomLink(), $('bar-link')))) toast(t(room.pass ? 'invite.copied.linkPass' : 'invite.copied.link'));
  });
  $('bar-more').addEventListener('click', (e) => { e.stopPropagation(); if (room) openMenu('invite'); });
  $('bar-close').addEventListener('click', () => { $('invite-bar').hidden = true; });
  $('gone-new').addEventListener('click', goHome);
  $('notice-new').addEventListener('click', startNew);
  $('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
  followComposer();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('confirm').hidden) $('confirm-no').click(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { unseen = 0; document.title = APP_NAME; }
  });
  window.addEventListener('hashchange', route);
  route();
}

boot();
