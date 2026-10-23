// Tests for the pastepage command (spawned as a child process) and for the session sweep timer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/pastepage.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const children = new Set();

after(() => { for (const c of children) c.kill('SIGKILL'); });

/** Spawn the CLI; resolves with the child plus collectors for stdout, stderr and the exit. */
function run(args = [], { env = {}, cwd } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal, ...out }); }));
  return { child, out, exited };
}

/** Wait until the child's stdout matches the pattern; resolves with the match. */
function waitFor(out, child, pattern) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pattern}; stdout=${out.stdout} stderr=${out.stderr}`)), 5000);
    const check = () => {
      const m = out.stdout.match(pattern);
      if (m) { clearTimeout(timer); resolve(m); }
    };
    child.stdout.on('data', check);
    check();
  });
}

const within = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`not done within ${ms}ms`)), ms))]);

test('starts and stops cleanly', async () => {
  const { child, out, exited } = run();
  const [, url] = await waitFor(out, child, /PastePage running at (http:\/\/127\.0\.0\.1:\d+\/)\n/);
  assert.equal(out.stdout, `PastePage running at ${url}\n`);
  assert.equal((await fetch(url)).status, 200);
  child.kill('SIGTERM');
  const result = await within(exited, 2000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `PastePage running at ${url}\nPastePage stopped\n`);
});

test('an invalid TRUST_PROXY exits 1 with a clear message and no stack trace', async () => {
  const { exited } = run([], { env: { TRUST_PROXY: '10.0.0.0/8' } });
  const result = await within(exited, 3000);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /TRUST_PROXY/);
  assert.ok(!result.stderr.includes('    at '), result.stderr);
});

test('stops cleanly on SIGINT', async () => {
  const { child, out, exited } = run();
  await waitFor(out, child, /running at/);
  child.kill('SIGINT');
  assert.equal((await within(exited, 2000)).code, 0);
});

test('reads .env from the current directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pastepage-'));
  try {
    writeFileSync(join(dir, '.env'), 'IDLE_SECONDS=abc\n');
    const result = await within(run([], { cwd: dir }).exited, 5000);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /IDLE_SECONDS/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real environment variables win over .env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pastepage-'));
  try {
    writeFileSync(join(dir, '.env'), 'IDLE_SECONDS=abc\n');
    const { child, out, exited } = run([], { cwd: dir, env: { IDLE_SECONDS: '60' } });
    await waitFor(out, child, /running at/);
    child.kill('SIGTERM');
    assert.equal((await within(exited, 2000)).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--help prints usage and exits 0', async () => {
  const result = await within(run(['--help']).exited, 5000);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /PORT/);
  assert.match(result.stdout, /HOST/);
  assert.match(result.stdout, /README/);
  assert.equal(result.stderr, '');
});

test('--version prints the package version', async () => {
  const result = await within(run(['--version']).exited, 5000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `${PKG.version}\n`);
  assert.equal(result.stderr, '');
});

test('unknown option prints the error and usage to stderr and exits 1', async () => {
  const result = await within(run(['--bogus']).exited, 5000);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bogus/);
  assert.match(result.stderr, /Usage/);
  assert.equal(result.stdout, '');
});

test('invalid --port prints just the message and exits 1', async () => {
  const result = await within(run(['--port', 'abc']).exited, 5000);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'Invalid PORT: "abc"\n');
});

test('--port and --host override the environment', async () => {
  const { child, out, exited } = run(['--port', '0', '--host', '127.0.0.1'], { env: { PORT: 'abc' } });
  await waitFor(out, child, /running at http:\/\/127\.0\.0\.1:\d+\//);
  child.kill('SIGTERM');
  assert.equal((await within(exited, 2000)).code, 0);
});

test('an address already in use exits 1 with a short message', async () => {
  const first = run();
  const [, , port] = await waitFor(first.out, first.child, /running at http:\/\/127\.0\.0\.1:(\d+)\//).then((m) => [m[0], m[1], m[1]]);
  const second = await within(run([], { env: { PORT: port } }).exited, 5000);
  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
  assert.doesNotMatch(second.stderr, /\n\s+at /);
  first.child.kill('SIGTERM');
  await within(first.exited, 2000);
});

test('sweep runs', async () => {
  const { app } = await start({ sweepMs: 50, idleSeconds: 0 });
  try {
    const id = '12-quiet-river';
    app.store.create({ id, authHash: 'x'.repeat(64), hours: 1 });
    assert.ok(app.store.get(id));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(app.store.get(id), undefined);
  } finally {
    await app.close();
  }
});
