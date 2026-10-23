// Tests for the wrong-password lockout and session-creation rate limiters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailureLimiter, RateLimiter } from '../src/limits.js';

const CFG = { maxFails: 10, windowSeconds: 900, lockSeconds: 900 };
const clock = () => {
  let t = 1_000_000;
  const now = () => t;
  now.advance = (s) => { t += s * 1000; };
  return now;
};
const IP = '192.0.2.1';

test('FailureLimiter locks on the 10th fail', () => {
  const now = clock();
  const l = new FailureLimiter(CFG, now);
  for (let i = 0; i < 9; i++) l.fail(IP);
  assert.equal(l.isLocked(IP), false);
  l.fail(IP);
  assert.equal(l.isLocked(IP), true);
});

test('FailureLimiter lock lasts lockSeconds then starts fresh', () => {
  const now = clock();
  const l = new FailureLimiter(CFG, now);
  for (let i = 0; i < 10; i++) l.fail(IP);
  now.advance(899);
  assert.equal(l.isLocked(IP), true);
  now.advance(1);
  assert.equal(l.isLocked(IP), false);
  for (let i = 0; i < 9; i++) l.fail(IP);
  assert.equal(l.isLocked(IP), false);
});

test('FailureLimiter does not extend a lock on further fails', () => {
  const now = clock();
  const l = new FailureLimiter(CFG, now);
  for (let i = 0; i < 10; i++) l.fail(IP);
  now.advance(600);
  l.fail(IP);
  now.advance(300);
  assert.equal(l.isLocked(IP), false);
});

test('FailureLimiter forgets fails older than the window', () => {
  const now = clock();
  const l = new FailureLimiter(CFG, now);
  for (let i = 0; i < 9; i++) l.fail(IP);
  now.advance(901);
  l.fail(IP);
  assert.equal(l.isLocked(IP), false);
  for (let i = 0; i < 8; i++) l.fail(IP);
  assert.equal(l.isLocked(IP), false);
  l.fail(IP);
  assert.equal(l.isLocked(IP), true);
});

test('FailureLimiter keeps IPs independent', () => {
  const now = clock();
  const l = new FailureLimiter(CFG, now);
  for (let i = 0; i < 10; i++) l.fail(IP);
  assert.equal(l.isLocked(IP), true);
  assert.equal(l.isLocked('198.51.100.1'), false);
});

test('FailureLimiter size shrinks after the window and a prune', () => {
  const now = clock();
  const l = new FailureLimiter(CFG, now);
  l.fail('192.0.2.1');
  l.fail('192.0.2.2');
  assert.equal(l.size, 2);
  now.advance(901);
  l.isLocked('203.0.113.1');
  assert.equal(l.size, 0);
});

test('FailureLimiter caps entries by dropping the oldest', () => {
  const now = clock();
  const l = new FailureLimiter(CFG, now);
  for (let i = 0; i < 50_001; i++) l.fail(`ip${i}`);
  assert.equal(l.size, 50_000);
});

test('RateLimiter allows limit calls, refuses, then allows after the window', () => {
  const now = clock();
  const r = new RateLimiter({ limit: 30, windowSeconds: 3600 }, now);
  for (let i = 0; i < 30; i++) assert.equal(r.allow(IP), true);
  assert.equal(r.allow(IP), false);
  assert.equal(r.allow('198.51.100.1'), true);
  now.advance(3599);
  assert.equal(r.allow(IP), false);
  now.advance(1);
  assert.equal(r.allow(IP), true);
});

test('RateLimiter size shrinks and is capped', () => {
  const now = clock();
  const r = new RateLimiter({ limit: 1, windowSeconds: 10 }, now);
  r.allow('192.0.2.1');
  assert.equal(r.size, 1);
  now.advance(11);
  r.allow('192.0.2.2');
  assert.equal(r.size, 1);
  for (let i = 0; i < 50_001; i++) r.allow(`ip${i}`);
  assert.equal(r.size, 50_000);
});
