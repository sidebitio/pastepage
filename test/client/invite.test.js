// Tests for public/js/invite.js: hash parsing, invite links and text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, inviteLink, inviteText } from '../../public/js/invite.js';

test('invite: parseHash', () => {
  const ok = { id: '12-dancing-apes', pass: 'tq7m8kxph3vdr2' };
  assert.deepEqual(parseHash('#12-dancing-apes/tq7m8kxph3vdr2'), ok);
  assert.deepEqual(parseHash('#12-dancing-apes'), { id: '12-dancing-apes', pass: '' });
  assert.deepEqual(parseHash('#12-Dancing-Apes/TQ7M8KXPH3VDR2'), ok);
  assert.deepEqual(parseHash('#12-dancing-apes%2Ftq7m8kxph3vdr2'), ok);
  assert.deepEqual(parseHash('#12-dancing-apes/tq7m8kxph3vdr2).'), ok);
  assert.deepEqual(parseHash('#12-dancing-apes).'), { id: '12-dancing-apes', pass: '' });
  assert.equal(parseHash('#'), null);
  assert.equal(parseHash('#foo'), null);
  assert.equal(parseHash(''), null);
});

test('invite: an over-long crafted hash is rejected quickly', () => {
  for (const hash of ['#' + '!'.repeat(50000) + 'a', '#12-dancing-apes/' + '!'.repeat(50000) + 'a', '#12-dancing-apes/tq7m8kxph3vdr2' + '.'.repeat(50000)]) {
    const t0 = performance.now();
    const r = parseHash(hash);
    const ms = performance.now() - t0;
    assert.equal(r, null);
    assert.ok(ms < 50, `took ${ms.toFixed(0)} ms`);
  }
  // a normal link with the punctuation chat apps add still works
  assert.deepEqual(parseHash('#12-dancing-apes/tq7m8kxph3vdr2' + '.'.repeat(20)), { id: '12-dancing-apes', pass: 'tq7m8kxph3vdr2' });
});

test('invite: links and text', () => {
  assert.equal(inviteLink('https://h/p/', '12-dancing-apes', 'abc'), 'https://h/p/#12-dancing-apes/abc');
  assert.equal(inviteLink('https://h/p/', '12-dancing-apes'), 'https://h/p/#12-dancing-apes');
  let seen;
  const fakeT = (k, v) => { seen = [k, v]; return 'x'; };
  assert.equal(inviteText(fakeT, { base: 'https://h/p/', id: '12-dancing-apes', pass: 'abc' }), 'x');
  assert.deepEqual(seen, ['invite.text', { link: 'https://h/p/#12-dancing-apes/abc', base: 'https://h/p/', id: '12-dancing-apes', pass: 'abc' }]);
});
