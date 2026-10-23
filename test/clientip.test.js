// Tests for trusted-proxy parsing and client IP resolution from X-Forwarded-For.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustProxy, clientIp, limitKey } from '../src/clientip.js';

const req = (remote, xff) => ({
  socket: { remoteAddress: remote },
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
});

test('loopback trust', () => {
  const t = parseTrustProxy('loopback');
  for (const a of ['127.0.0.1', '127.8.9.1', '::1', '::ffff:127.0.0.1']) assert.equal(t(a), true, a);
  assert.equal(t('10.0.0.1'), false);
});

test('trust values', () => {
  assert.equal(parseTrustProxy('false')('127.0.0.1'), false);
  assert.equal(parseTrustProxy('FALSE')('8.8.8.8'), false);
  assert.equal(parseTrustProxy(' True ')('8.8.8.8'), true);
  const t = parseTrustProxy('10.0.0.5, 10.0.0.6');
  assert.equal(t('10.0.0.5'), true);
  assert.equal(t('10.0.0.6'), true);
  assert.equal(t('10.0.0.7'), false);
  assert.equal(t('127.0.0.1'), false);
});

test('parseTrustProxy rejects bad values', () => {
  assert.throws(() => parseTrustProxy('banana'), /banana/);
  assert.throws(() => parseTrustProxy('10.0.0.5, nope'), /nope/);
  assert.throws(() => parseTrustProxy(''), Error);
});

test('clientIp reads XFF from a trusted peer', () => {
  const t = parseTrustProxy('loopback');
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9'), t), '203.0.113.9');
});

test('clientIp ignores XFF from an untrusted peer', () => {
  const t = parseTrustProxy('loopback');
  assert.equal(clientIp(req('198.51.100.7', '1.2.3.4'), t), '198.51.100.7');
});

test('clientIp walks right to left, skipping trusted hops', () => {
  const t = parseTrustProxy('loopback');
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9, 127.0.0.1'), t), '203.0.113.9');
  // a spoofed leftmost entry is not believed
  assert.equal(clientIp(req('127.0.0.1', '192.0.2.1, 203.0.113.9'), t), '203.0.113.9');
});

test('clientIp returns the leftmost entry when all are trusted', () => {
  const t = parseTrustProxy('loopback');
  assert.equal(clientIp(req('127.0.0.1', '127.0.0.2, 127.0.0.1'), t), '127.0.0.2');
});

test('clientIp ignores malformed entries and falls back to the peer', () => {
  const t = parseTrustProxy('loopback');
  assert.equal(clientIp(req('127.0.0.1', 'garbage, 203.0.113.9, '), t), '203.0.113.9');
  assert.equal(clientIp(req('127.0.0.1', 'garbage, ,'), t), '127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1', ''), t), '127.0.0.1');
});

test('clientIp without XFF gives the remote address', () => {
  assert.equal(clientIp(req('198.51.100.7'), parseTrustProxy('loopback')), '198.51.100.7');
  assert.equal(clientIp(req('127.0.0.1'), parseTrustProxy('loopback')), '127.0.0.1');
});

test('clientIp normalises IPv4-mapped IPv6', () => {
  const t = parseTrustProxy('loopback');
  assert.equal(clientIp(req('::ffff:1.2.3.4'), t), '1.2.3.4');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '::ffff:203.0.113.9'), t), '203.0.113.9');
});

test('clientIp tolerates a missing socket address', () => {
  assert.equal(clientIp({ socket: {}, headers: {} }, parseTrustProxy('loopback')), '');
});

test('limitKey groups IPv6 addresses by their /64 and leaves IPv4 alone', () => {
  // Addresses from the documentation ranges (RFC 3849 for IPv6, RFC 5737 for IPv4).
  assert.equal(limitKey('2001:db8:0:1::1'), limitKey('2001:db8:0:1:ffff:ffff:ffff:ffff'));
  assert.equal(limitKey('2001:db8:0:1::1'), limitKey('2001:0DB8:0000:0001:0:0:0:2'));
  assert.notEqual(limitKey('2001:db8:0:1::1'), limitKey('2001:db8:0:2::1'));
  assert.equal(limitKey('2001:db8:0:1::1'), '2001:db8:0:1::/64');
  assert.equal(limitKey('::1'), '0:0:0:0::/64');
  assert.equal(limitKey('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(limitKey('::ffff:0:1'), '0:0:0:0::/64');
  assert.equal(limitKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64'); // an IPv4 tail sits in the last 32 bits
  assert.equal(limitKey('fe80::1%en0'), 'fe80:0:0:0::/64');
  assert.equal(limitKey('203.0.113.9'), '203.0.113.9');
  assert.notEqual(limitKey('203.0.113.9'), limitKey('203.0.113.10'));
  assert.equal(limitKey(''), '');
});

test('clientIp still gives the full IPv6 address', () => {
  const t = parseTrustProxy('loopback');
  assert.equal(clientIp(req('127.0.0.1', '2001:db8:0:1::7'), t), '2001:db8:0:1::7');
});
