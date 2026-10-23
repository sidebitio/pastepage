// Tests for config loading: defaults, env overrides, argument precedence, validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ERRORS, AppError } from '../src/errors.js';

test('defaults', () => { const c = loadConfig({}); assert.equal(c.port, 3000); assert.equal(c.host, '127.0.0.1'); assert.equal(c.trustProxy, 'loopback'); assert.equal(c.idleSeconds, 120); assert.equal(c.maxNoteBytes, 1500000); assert.equal(c.createPerHour, 30); });
test('env overrides', () => { const c = loadConfig({ PORT: '8080', HOST: '0.0.0.0', TRUST_PROXY: 'false', IDLE_SECONDS: '60' }); assert.equal(c.port, 8080); assert.equal(c.host, '0.0.0.0'); assert.equal(c.trustProxy, 'false'); assert.equal(c.idleSeconds, 60); });
test('args beat env', () => { assert.equal(loadConfig({ PORT: '8080' }, { port: '9000' }).port, 9000); });
test('bad numbers name the variable', () => { assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/); assert.throws(() => loadConfig({ MAX_EVENTS: '-1' }), /MAX_EVENTS/); });
test('an invalid TRUST_PROXY is rejected by name', () => { assert.throws(() => loadConfig({ TRUST_PROXY: '10.0.0.0/8' }), /TRUST_PROXY/); assert.equal(loadConfig({ TRUST_PROXY: '10.0.0.5,::1' }).trustProxy, '10.0.0.5,::1'); });
test('MAX_HOURS below 1 is rejected, 1 is allowed', () => { assert.throws(() => loadConfig({ MAX_HOURS: '0' }), /Invalid MAX_HOURS: "0"/); assert.equal(loadConfig({ MAX_HOURS: '1' }).maxHours, 1); });
test('port 0 allowed', () => { assert.equal(loadConfig({ PORT: '0' }).port, 0); });
test('connection limits have defaults and are not read from the environment', () => {
  const env = {
    MAX_SOCKETS_PER_IP: '1', MAX_SOCKETS_PER_SESSION: '1', MAX_PENDING_PER_IP: '1', MAX_BUFFERED_BYTES: '1',
    MAX_SOCKETS_TOTAL: '1', MAX_PENDING_TOTAL: '1', MAX_WELCOME_BYTES_IN_FLIGHT: '1',
  };
  const c = loadConfig(env);
  assert.deepEqual([c.maxSocketsPerIp, c.maxSocketsPerSession, c.maxPendingPerIp, c.maxBufferedBytes], [20, 50, 10, 16 * 1024 * 1024]);
  assert.deepEqual([c.maxSocketsTotal, c.maxPendingTotal, c.maxWelcomeBytesInFlight], [1000, 200, 256 * 1024 * 1024]);
});

test('error table matches the protocol', () => {
  assert.deepEqual(ERRORS, { BAD_REQUEST: 400, NOT_FOUND: 404, LOCKED: 429, RATE_LIMITED: 429, TAKEN: 409, TOO_LARGE: 413, SESSION_FULL: 413, SERVER_FULL: 503, GONE: 410, FORBIDDEN: 403, METHOD: 405, INTERNAL: 500 });
});
test('AppError carries code and status; unknown code throws', () => {
  const e = new AppError('GONE');
  assert.ok(e instanceof Error); assert.equal(e.code, 'GONE'); assert.equal(e.status, 410);
  assert.throws(() => new AppError('NOPE'), /NOPE/);
});
