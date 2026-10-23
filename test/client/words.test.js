// Tests for public/js/words.js: id and password generators and normalisers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ID_RE, newSessionId, newPassword, normId, normPass } from '../../public/js/words.js';

test('words: generated ids match ID_RE', () => {
  for (let i = 0; i < 200; i++) assert.match(newSessionId(), ID_RE);
});

test('words: password alphabet and length', () => {
  assert.match(newPassword(), /^[abcdefghjkmnpqrstuvwxyz23456789]{14}$/);
});

test('words: normalisers', () => {
  assert.equal(normId(' 12 Dancing_Apes '), '12-dancing-apes');
  assert.equal(normPass('TQ7M-8kxp h3vd'), 'tq7m8kxph3vd');
});
