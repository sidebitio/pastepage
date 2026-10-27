// Tests for the browser state reducer (public/js/state.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REACTIONS, PIN_PREVIEW_LINES, createState, keepRolled, setRolled, applyEvent, removeNote,
  noteList, pinnedList, reactionsFor, replyInfo, noteView, lineCount,
} from '../../public/js/state.js';

const ME = 'me-client';
const note = (seq, client = 'other', extra = {}) => [
  { seq, ts: 100 + seq, kind: 'note', client },
  { v: 1, t: `text ${seq}`, l: 'js', n: 'Ada', c: client, ...extra },
];
const meta = (seq, client, payload) => [{ seq, ts: 200, kind: 'meta', client }, { v: 1, ...payload }];
const burn = (seq, client = 'other') => [{ seq, ts: 100, kind: 'burn', client, size: 5 }, undefined];
const add = (s, [ev, p]) => applyEvent(s, ev, p);

test('constants', () => {
  assert.deepEqual(REACTIONS, ['👍', '❤️', '😂', '🎉', '👀', '✅']);
  assert.equal(PIN_PREVIEW_LINES, 4);
});

test('notes in seq order with fields', () => {
  const s = createState(ME);
  add(s, note(1, ME, {}));
  add(s, note(2, 'x', { r: 1 }));
  const l = noteList(s);
  assert.deepEqual(l.map((n) => n.seq), [1, 2]);
  assert.equal(l[0].mine, true);
  assert.equal(l[1].mine, false);
  assert.equal(l[0].name, 'Ada');
  assert.equal(l[0].text, 'text 1');
  assert.equal(l[0].lang, 'js');
  assert.equal(l[0].ts, 101);
  assert.equal(l[0].client, ME);
  assert.equal(l[0].replyTo, null);
  assert.equal(l[1].replyTo, 1);
  assert.equal(l[0].broken, false);
  assert.equal(l[0].pinned, false);
  assert.equal(l[0].burn, null);
  assert.equal(s.lastSeq, 2);
  assert.deepEqual(noteView(s, 2), l[1]);
  assert.equal(noteView(s, 9), undefined);
});

test('idempotent', () => {
  const s = createState(ME);
  add(s, note(3));
  const before = JSON.stringify(noteList(s));
  add(s, note(3));
  add(s, note(2));
  assert.equal(JSON.stringify(noteList(s)), before);
  assert.equal(s.lastSeq, 3);
});

test('lists are copies', () => {
  const s = createState(ME);
  add(s, note(1));
  noteList(s)[0].text = 'hacked';
  noteList(s).pop();
  assert.equal(noteList(s)[0].text, 'text 1');
  add(s, meta(2, 'a', { m: 'pin', note: 1, on: true, n: 'Ada', c: 'a' }));
  pinnedList(s)[0].text = 'hacked';
  assert.equal(pinnedList(s)[0].text, 'text 1');
});

test('delete', () => {
  const s = createState(ME);
  add(s, note(1));
  add(s, note(2, 'x', { r: 1 }));
  add(s, meta(3, 'a', { m: 'react', note: 1, e: '👍', on: true, n: 'Ada', c: 'a' }));
  add(s, meta(4, 'a', { m: 'pin', note: 1, on: true, n: 'Ada', c: 'a' }));
  add(s, [{ seq: 5, ts: 1, kind: 'delete', target: 1 }, undefined]);
  assert.deepEqual(noteList(s).map((n) => n.seq), [2]);
  assert.deepEqual(replyInfo(s, 1), { exists: false });
  assert.equal(noteList(s)[0].replyTo, 1);
  assert.deepEqual(reactionsFor(s, 1), []);
  assert.deepEqual(pinnedList(s), []);
  assert.deepEqual(replyInfo(s, 2), { exists: true, name: 'Ada', lang: 'js', lines: 1, image: null });
});

test('clear', () => {
  const s = createState(ME);
  add(s, note(1));
  add(s, meta(2, 'a', { m: 'react', note: 1, e: '👍', on: true, n: 'Ada', c: 'a' }));
  add(s, meta(3, 'a', { m: 'pin', note: 1, on: true, n: 'Ada', c: 'a' }));
  add(s, [{ seq: 4, ts: 1, kind: 'clear' }, undefined]);
  assert.deepEqual(noteList(s), []);
  assert.deepEqual(pinnedList(s), []);
  assert.deepEqual(reactionsFor(s, 1), []);
  add(s, note(5));
  assert.deepEqual(noteList(s).map((n) => n.seq), [5]);
});

test('reactions', () => {
  const s = createState(ME);
  add(s, note(1));
  const r = (seq, client, name, e, on) => add(s, meta(seq, client, { m: 'react', note: 1, e, on, n: name, c: 'zzz' }));
  r(2, 'a', 'Ada', '👍', true);
  r(3, ME, 'Linus', '👍', true);
  r(4, 'a', 'Ada', '🎉', true);
  r(5, 'a', 'Ada', '❤️', true);
  r(6, 'a', 'Ada', '🤖', true);
  assert.deepEqual(reactionsFor(s, 1), [
    { emoji: '👍', count: 2, names: ['Ada', 'Linus'], mine: true },
    { emoji: '❤️', count: 1, names: ['Ada'], mine: false },
    { emoji: '🎉', count: 1, names: ['Ada'], mine: false },
  ]);
  r(7, 'a', 'Ada', '👍', false);
  assert.equal(reactionsFor(s, 1)[0].count, 1);
  assert.deepEqual(reactionsFor(s, 1)[0].names, ['Linus']);
  r(8, 'a', 'Ada', '👍', true);
  r(9, 'a', 'Ada', '👍', false);
  r(10, 'a', 'Ada', '👍', true);
  assert.equal(reactionsFor(s, 1)[0].count, 2);
  assert.deepEqual(reactionsFor(s, 99), []);
});

test('pins', () => {
  const s = createState(ME);
  add(s, note(1)); add(s, note(2)); add(s, note(5));
  const p = (seq, n, on) => add(s, meta(seq, 'a', { m: 'pin', note: n, on, n: 'Ada', c: 'a' }));
  p(6, 5, true); p(7, 2, true);
  assert.deepEqual(pinnedList(s).map((n) => n.seq), [2, 5]);
  assert.equal(pinnedList(s)[0].pinned, true);
  p(8, 2, false);
  assert.deepEqual(pinnedList(s).map((n) => n.seq), [5]);
  p(9, 99, true);
  add(s, [{ seq: 10, ts: 1, kind: 'delete', target: 5 }, undefined]);
  assert.deepEqual(pinnedList(s), []);
});

test('burn', () => {
  const s = createState(ME);
  add(s, burn(1));
  let n = noteList(s)[0];
  assert.equal(n.burn, 'waiting');
  assert.equal(n.text, undefined);
  add(s, [{ seq: 2, ts: 1, kind: 'burned', target: 1, client: 'z' }, undefined]);
  assert.equal(noteList(s)[0].burn, 'burned');
  add(s, meta(3, 'z', { m: 'burnRead', note: 1, n: 'Ada', c: 'z' }));
  assert.equal(noteList(s)[0].burnedBy, 'Ada');
  // targeting a burn note is ignored
  add(s, meta(4, 'a', { m: 'react', note: 1, e: '👍', on: true, n: 'Ada', c: 'a' }));
  add(s, meta(5, 'a', { m: 'pin', note: 1, on: true, n: 'Ada', c: 'a' }));
  add(s, note(6, 'x', { r: 1 }));
  assert.deepEqual(reactionsFor(s, 1), []);
  assert.deepEqual(pinnedList(s), []);
  assert.equal(noteView(s, 6).replyTo, null);
  assert.deepEqual(replyInfo(s, 1), { exists: true, name: '', lang: '', lines: 0, image: null });
});

test('burnRead on a regular note is ignored', () => {
  const s = createState(ME);
  add(s, note(1));
  add(s, meta(2, 'z', { m: 'burnRead', note: 1, n: 'Ada', c: 'z' }));
  assert.equal(noteView(s, 1).burnedBy, null);
});

test('burnRead is only accepted from the client that opened the note', () => {
  const s = createState(ME);
  add(s, burn(1));
  // before the burned event: ignored
  add(s, meta(2, 'z', { m: 'burnRead', note: 1, n: 'Early', c: 'z' }));
  assert.equal(noteView(s, 1).burnedBy, null);
  add(s, [{ seq: 3, ts: 1, kind: 'burned', target: 1, client: 'z' }, undefined]);
  // another client cannot fake it
  add(s, meta(4, 'evil', { m: 'burnRead', note: 1, n: 'Mallory', c: 'evil' }));
  assert.equal(noteView(s, 1).burnedBy, null);
  // the opener sets it, and may update the name
  add(s, meta(5, 'z', { m: 'burnRead', note: 1, n: 'Ada', c: 'z' }));
  assert.equal(noteView(s, 1).burnedBy, 'Ada');
  add(s, meta(6, 'evil', { m: 'burnRead', note: 1, n: 'Mallory', c: 'evil' }));
  assert.equal(noteView(s, 1).burnedBy, 'Ada');
  add(s, meta(7, 'z', { m: 'burnRead', note: 1, n: 'Ada L', c: 'z' }));
  assert.equal(noteView(s, 1).burnedBy, 'Ada L');
});

test('broken payload', () => {
  const s = createState(ME);
  add(s, [{ seq: 1, ts: 1, kind: 'note', client: 'a' }, null]);
  add(s, [{ seq: 2, ts: 1, kind: 'note', client: 'a' }, { v: 2, t: 'x', l: '', n: 'A' }]);
  add(s, [{ seq: 3, ts: 1, kind: 'note', client: 'a' }, { v: 1, t: 5, l: '', n: 'A' }]);
  for (const n of noteList(s)) assert.equal(n.broken, true);
  assert.equal(noteList(s).length, 3);
  assert.equal(s.lastSeq, 3);
});

test('reply validation', () => {
  const s = createState(ME);
  add(s, note(1, 'a', { r: 1.5 }));
  add(s, note(2, 'a', { r: '1' }));
  add(s, note(3, 'a', { r: 1 }));
  add(s, note(4, 'a', { r: 50 })); // a missing note that is not earlier than this one: not a real reply
  assert.deepEqual(noteList(s).map((n) => n.replyTo), [null, null, 1, null]);
  assert.deepEqual(replyInfo(s, 50), { exists: false });
});

test('unknown meta ignored', () => {
  const s = createState(ME);
  add(s, note(1));
  add(s, meta(2, 'a', { m: 'dance', note: 1 }));
  add(s, [{ seq: 3, ts: 1, kind: 'meta', client: 'a' }, { v: 2, m: 'pin', note: 1, on: true, n: 'A' }]);
  add(s, [{ seq: 4, ts: 1, kind: 'meta', client: 'a' }, null]);
  add(s, meta(5, 'a', { m: 'pin', note: 1, on: 'yes', n: 'A' }));
  add(s, meta(6, 'a', { m: 'react', note: 1, e: '👍', on: true, n: 7 }));
  assert.deepEqual(pinnedList(s), []);
  assert.deepEqual(reactionsFor(s, 1), []);
  assert.equal(s.lastSeq, 6);
});

test('keepRolled with nothing rolled empties the state for a replay', () => {
  const s = createState(ME);
  add(s, note(1));
  keepRolled(s, 0);
  assert.equal(s.lastSeq, -1);
  assert.deepEqual(noteList(s), []);
  add(s, note(1));
  assert.equal(noteList(s).length, 1);
});

test('lineCount', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\n'), 1);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount('a\n\n'), 2);
});

test('lineCount counts old Mac (CR) and Windows (CRLF) line breaks too', () => {
  assert.equal(lineCount('a\rb\r'), 2);
  assert.equal(lineCount('a\r\nb'), 2);
  assert.equal(lineCount('a\r\nb\r\n'), 2);
  assert.equal(lineCount('a\r\rb'), 3);
  assert.equal(lineCount('a\r\n\rb\n'), 3);
});

/* ---------- image notes ---------- */

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
const img = (extra = {}) => ({ mime: 'image/png', data: PNG_B64, w: 1280, h: 800, bytes: 12, orig: { mime: 'image/png', bytes: 3000000 }, ...extra });

test('image note: the view carries the checked image and the caption as text', () => {
  const s = createState(ME);
  add(s, note(1, 'x', { t: 'a caption', l: 'plaintext', image: img() }));
  const v = noteView(s, 1);
  assert.equal(v.broken, false);
  assert.equal(v.text, 'a caption');
  assert.deepEqual(v.image, { mime: 'image/png', data: PNG_B64, w: 1280, h: 800, bytes: 12, orig: { mime: 'image/png', bytes: 3000000 } });
  assert.deepEqual(replyInfo(s, 1), { exists: true, name: 'Ada', lang: 'plaintext', lines: 1, image: { w: 1280, h: 800 } });
});

test('image note: a text note has no image', () => {
  const s = createState(ME);
  add(s, note(1));
  assert.equal(noteView(s, 1).image, null);
});

test('image note: a bad image makes the note unreadable, without its caption', () => {
  for (const bad of [img({ mime: 'image/svg+xml' }), img({ data: 'not base64!' }), img({ w: 0 }), img({ h: 2.5 }), null, 'x']) {
    const s = createState(ME);
    add(s, note(1, 'x', { t: 'caption', image: bad }));
    const v = noteView(s, 1);
    assert.equal(v.broken, true, JSON.stringify(bad));
    assert.equal(v.image, null);
    assert.equal(v.text, '');
  }
});

test('image note: reactions, pins and replies work as for any note', () => {
  const s = createState(ME);
  add(s, note(1, 'x', { t: '', image: img() }));
  add(s, meta(2, 'y', { m: 'react', note: 1, e: '👍', on: true, n: 'Bo' }));
  add(s, meta(3, 'y', { m: 'pin', note: 1, on: true, n: 'Bo' }));
  add(s, note(4, 'y', { r: 1 }));
  assert.equal(reactionsFor(s, 1).length, 1);
  assert.deepEqual(pinnedList(s).map((n) => n.seq), [1]);
  assert.equal(noteView(s, 4).replyTo, 1);
});

/* ---------- previews of image notes ---------- */

const WEBP_B64 = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).toString('base64');
const full = (extra = {}) => ({ mime: 'image/png', w: 1920, h: 1440, bytes: 720000, orig: { mime: 'image/png', bytes: 3000000 }, ...extra });
const imageEv = (seq, payload, client = 'other') => [{ seq, ts: 100 + seq, kind: 'image', client }, payload];
const previewPayload = (extra = {}) => ({
  v: 1, t: 'a caption', l: 'plaintext', n: 'Ada',
  image: img({ mime: 'image/webp', data: WEBP_B64, w: 480, h: 360, orig: undefined }), preview: true, full: full(), ...extra,
});

test('createState starts with nothing rolled', () => {
  assert.equal(createState(ME).rolledSeq, 0);
});

test('an image event with the full payload is an image note like any other', () => {
  const s = createState(ME);
  add(s, imageEv(1, { v: 1, t: 'x', l: 'plaintext', n: 'Ada', image: img() }));
  const v = noteView(s, 1);
  assert.equal(v.broken, false);
  assert.equal(v.image.w, 1280);
  assert.equal(v.preview, false);
  assert.equal(v.full, null);
  assert.equal(s.lastSeq, 1);
});

test('an image event with the preview payload: the view shows the preview and describes the full', () => {
  const s = createState(ME);
  add(s, imageEv(1, previewPayload()));
  const v = noteView(s, 1);
  assert.equal(v.broken, false);
  assert.equal(v.text, 'a caption');
  assert.equal(v.preview, true);
  assert.equal(v.image.mime, 'image/webp');
  assert.equal(v.image.w, 480);
  assert.deepEqual(v.full, { mime: 'image/png', w: 1920, h: 1440, bytes: 720000, orig: { mime: 'image/png', bytes: 3000000 } });
  // the view's full is a copy
  v.full.w = 1;
  v.full.orig.bytes = 1;
  assert.equal(noteView(s, 1).full.w, 1920);
  assert.equal(noteView(s, 1).full.orig.bytes, 3000000);
});

test('replyInfo for a preview gives the full image size, not the preview size', () => {
  const s = createState(ME);
  add(s, imageEv(1, previewPayload()));
  assert.deepEqual(replyInfo(s, 1), { exists: true, name: 'Ada', lang: 'plaintext', lines: 1, image: { w: 1920, h: 1440 } });
});

test('a preview whose full has a missing or odd orig takes the full itself as the original', () => {
  for (const orig of [undefined, null, { mime: 'image/svg+xml', bytes: 5 }, { mime: 'image/png', bytes: 0 }]) {
    const s = createState(ME);
    add(s, imageEv(1, previewPayload({ full: full({ orig }) })));
    assert.deepEqual(noteView(s, 1).full.orig, { mime: 'image/png', bytes: 720000 }, JSON.stringify(orig));
  }
});

test('a preview with an invalid full is a broken note', () => {
  const bad = [
    null, 'x', [], full({ mime: 'image/svg+xml' }), full({ mime: undefined }), full({ w: 0 }), full({ h: 2.5 }),
    full({ bytes: -1 }), full({ bytes: '720000' }), full({ w: Number.MAX_SAFE_INTEGER + 1 }),
  ];
  for (const f of bad) {
    const s = createState(ME);
    add(s, imageEv(1, previewPayload({ full: f })));
    const v = noteView(s, 1);
    assert.equal(v.broken, true, JSON.stringify(f));
    assert.equal(v.text, '');
    assert.equal(v.image, null);
    assert.equal(v.preview, false);
    assert.equal(v.full, null);
  }
});

test('a preview without an image is a broken note', () => {
  const s = createState(ME);
  add(s, imageEv(1, previewPayload({ image: undefined })));
  assert.equal(noteView(s, 1).broken, true);
});

test('a text note has no preview and no full', () => {
  const s = createState(ME);
  add(s, note(1));
  assert.equal(noteView(s, 1).preview, false);
  assert.equal(noteView(s, 1).full, null);
});

test('an image event that does not decrypt is a broken note', () => {
  const s = createState(ME);
  add(s, imageEv(1, null));
  add(s, imageEv(2, undefined));
  assert.deepEqual(noteList(s).map((n) => n.broken), [true, true]);
});

/* ---------- rolled-off notes ---------- */

test('view.rolled follows setRolled, which only goes up', () => {
  const s = createState(ME);
  for (let i = 1; i <= 4; i++) add(s, note(i));
  assert.deepEqual(noteList(s).map((n) => n.rolled), [false, false, false, false]);
  setRolled(s, 2);
  assert.equal(s.rolledSeq, 2);
  assert.deepEqual(noteList(s).map((n) => n.rolled), [true, true, false, false]);
  setRolled(s, 1);
  assert.equal(s.rolledSeq, 2);
  for (const bad of [undefined, null, '3', 3.5, NaN]) setRolled(s, bad);
  assert.equal(s.rolledSeq, 2);
  setRolled(s, 3);
  assert.deepEqual(noteList(s).map((n) => n.rolled), [true, true, true, false]);
  assert.equal(noteView(s, 3).rolled, true);
  assert.deepEqual(pinnedList(s), []);
});

/** Notes 1..5, each with a reaction, and pins on 2 and 5; a reply from 5 to 1. */
function fiveNotes() {
  const s = createState(ME);
  for (let i = 1; i <= 5; i++) add(s, note(i, 'x', i === 5 ? { r: 1 } : {}));
  let seq = 6;
  for (let i = 1; i <= 5; i++) add(s, meta(seq++, 'a', { m: 'react', note: i, e: '👍', on: true, n: 'Bo' }));
  add(s, meta(seq++, 'a', { m: 'pin', note: 2, on: true, n: 'Bo' }));
  add(s, meta(seq++, 'a', { m: 'pin', note: 5, on: true, n: 'Bo' }));
  return s;
}

test('keepRolled keeps the rolled-off notes with their reactions and pins, and empties the rest', () => {
  const s = fiveNotes();
  keepRolled(s, 3);
  assert.equal(s.lastSeq, -1);
  assert.deepEqual(noteList(s).map((n) => n.seq), [1, 2, 3]);
  for (const i of [1, 2, 3]) assert.equal(reactionsFor(s, i).length, 1, `reaction on ${i}`);
  for (const i of [4, 5]) assert.deepEqual(reactionsFor(s, i), []);
  assert.deepEqual(pinnedList(s).map((n) => n.seq), [2]);
  assert.equal(noteView(s, 1).text, 'text 1');
});

test('a snapshot after keepRolled shows the kept notes and the snapshot\'s', () => {
  const s = fiveNotes();
  keepRolled(s, 3);
  setRolled(s, 3);
  add(s, note(6));
  assert.deepEqual(noteList(s).map((n) => n.seq), [1, 2, 3, 6]);
  assert.deepEqual(noteList(s).map((n) => n.rolled), [true, true, true, false]);
  assert.equal(s.lastSeq, 6);
});

test('a snapshot with a clear after keepRolled removes the kept notes too', () => {
  const s = fiveNotes();
  keepRolled(s, 3);
  add(s, [{ seq: 7, ts: 1, kind: 'clear' }, undefined]);
  add(s, note(8));
  assert.deepEqual(noteList(s).map((n) => n.seq), [8]);
  assert.deepEqual(pinnedList(s), []);
  for (const i of [1, 2, 3]) assert.deepEqual(reactionsFor(s, i), []);
});

test('keepRolled without a usable rolled value empties everything', () => {
  for (const bad of [undefined, null, -1, '3', 2.5]) {
    const s = fiveNotes();
    keepRolled(s, bad);
    assert.deepEqual(noteList(s), [], JSON.stringify(bad));
    assert.deepEqual(pinnedList(s), []);
    assert.equal(s.reactions.size, 0);
    assert.equal(s.lastSeq, -1);
  }
});

test('keepRolled drops kept notes up to a clear that rolled off while the page was away', () => {
  // The page had 1-5 with reactions and pins; someone cleared (seq 13) and the session then rolled past the clear,
  // so the snapshot has no clear event: only the welcome's cleared value says so.
  const s = fiveNotes();
  keepRolled(s, 14, 13);
  setRolled(s, 14);
  add(s, note(15));
  assert.deepEqual(noteList(s).map((n) => n.seq), [15]);
  assert.deepEqual(pinnedList(s), []);
  assert.equal(s.reactions.size, 0);
});

test('keepRolled keeps the rolled-off notes after the clear', () => {
  const s = fiveNotes();
  keepRolled(s, 3, 1);
  assert.deepEqual(noteList(s).map((n) => n.seq), [2, 3]);
  assert.deepEqual(pinnedList(s).map((n) => n.seq), [2]);
  for (const bad of [undefined, null, -1, '3', 2.5]) {
    const t = fiveNotes();
    keepRolled(t, 3, bad);
    assert.deepEqual(noteList(t).map((n) => n.seq), [1, 2, 3], JSON.stringify(bad));
  }
});

test('removeNote takes a note out with its reactions and pin', () => {
  const s = fiveNotes();
  removeNote(s, 2);
  assert.deepEqual(noteList(s).map((n) => n.seq), [1, 3, 4, 5]);
  assert.deepEqual(reactionsFor(s, 2), []);
  assert.deepEqual(pinnedList(s).map((n) => n.seq), [5]);
  const last = s.lastSeq;
  removeNote(s, 99);
  assert.equal(s.lastSeq, last);
  assert.equal(noteList(s).length, 4);
});

/* ---------- replies to notes that are gone ---------- */

test('a reply to an earlier note that is not there keeps replyTo; replyInfo says it does not exist', () => {
  const s = createState(ME);
  add(s, note(5, 'x', { r: 2 }));
  assert.equal(noteView(s, 5).replyTo, 2);
  assert.deepEqual(replyInfo(s, 2), { exists: false });
  add(s, note(6, 'x', { r: 6 }));
  add(s, note(7, 'x', { r: 9 }));
  assert.equal(noteView(s, 6).replyTo, null);
  assert.equal(noteView(s, 7).replyTo, null);
});

test('a reply to a rolled-off note that was kept still points at it', () => {
  const s = fiveNotes();
  keepRolled(s, 3);
  add(s, note(20, 'x', { r: 1 }));
  assert.equal(noteView(s, 20).replyTo, 1);
  assert.equal(replyInfo(s, 1).exists, true);
});
