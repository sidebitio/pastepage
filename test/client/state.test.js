// Tests for the browser state reducer (public/js/state.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REACTIONS, PIN_PREVIEW_LINES, createState, resetState, applyEvent,
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
  assert.deepEqual(replyInfo(s, 2), { exists: true, name: 'Ada', lang: 'js', lines: 1 });
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
  assert.deepEqual(replyInfo(s, 1), { exists: true, name: '', lang: '', lines: 0 });
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
  add(s, note(4, 'a', { r: 50 }));
  assert.deepEqual(noteList(s).map((n) => n.replyTo), [null, null, 1, 50]);
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

test('resetState allows replay', () => {
  const s = createState(ME);
  add(s, note(1));
  resetState(s);
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
