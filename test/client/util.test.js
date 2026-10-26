// Tests for chooseOutgoing and displayText in public/js/util.js: an unedited paste is sent byte for byte, line endings
// included, and shown with every kind of line ending as a line break.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseOutgoing, displayText } from '../../public/js/util.js';

test('outgoing: an unedited paste is sent as pasted, with Windows and old Mac line endings', () => {
  assert.equal(chooseOutgoing({ raw: 'a\r\nb\r\n', valueAfterPaste: 'a\nb\n', current: 'a\nb\n' }), 'a\r\nb\r\n');
  assert.equal(chooseOutgoing({ raw: 'a\rb\r', valueAfterPaste: 'a\nb\n', current: 'a\nb\n' }), 'a\rb\r');
  assert.equal(chooseOutgoing({ raw: 'a\r\n\rb\n', valueAfterPaste: 'a\n\nb\n', current: 'a\n\nb\n' }), 'a\r\n\rb\n');
  assert.equal(chooseOutgoing({ raw: 'plain\ntext', valueAfterPaste: 'plain\ntext', current: 'plain\ntext' }), 'plain\ntext');
});

test('outgoing: an edited or typed text is sent as the box holds it', () => {
  assert.equal(chooseOutgoing({ raw: 'a\r\nb', valueAfterPaste: 'a\nb', current: 'a\nb!' }), 'a\nb!');
  assert.equal(chooseOutgoing({ raw: null, valueAfterPaste: null, current: 'typed\n' }), 'typed\n');
  assert.equal(chooseOutgoing({ raw: '', valueAfterPaste: '', current: 'typed' }), 'typed');
});

test('outgoing: a paste into text already in the box, or one the box changed otherwise, is sent as the box holds it', () => {
  // pasted into existing text: the box holds more than the paste
  assert.equal(chooseOutgoing({ raw: 'x\r\n', valueAfterPaste: 'hello x\n', current: 'hello x\n' }), 'hello x\n');
  // the box changed more than line endings (for example cut short)
  assert.equal(chooseOutgoing({ raw: 'abc\r\n', valueAfterPaste: 'ab', current: 'ab' }), 'ab');
});

test('displayText shows CR and CRLF line endings as line breaks, and changes nothing else', () => {
  assert.equal(displayText('a\rb\r\nc\n'), 'a\nb\nc\n');
  assert.equal(displayText('progress 10%\rprogress 100%\r'), 'progress 10%\nprogress 100%\n');
  assert.equal(displayText('a\r\n\rb'), 'a\n\nb');
  assert.equal(displayText('  tabs\tand spaces  \n'), '  tabs\tand spaces  \n');
  assert.equal(displayText(''), '');
});

test('fold: only notes longer than the limit are folded', async () => {
  const { isFoldable } = await import('../../public/js/util.js');
  assert.equal(isFoldable(28, 28), false);
  assert.equal(isFoldable(29, 28), true);
  assert.equal(isFoldable(1, 28), false);
});

test('scroll: the window moves by how far the element moved', async () => {
  const { scrollDelta } = await import('../../public/js/util.js');
  assert.equal(scrollDelta(300, 300), 0);
  assert.equal(scrollDelta(300, 1200), 900);
  assert.equal(scrollDelta(1200, 300), -900);
});
