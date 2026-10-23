#!/usr/bin/env node
// The pastepage command: parses flags, loads .env, starts the server and shuts down cleanly on signals.
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPastePage } from '../src/server.js';

const USAGE = `Usage: pastepage [options]

Options:
  --port <n>     port to listen on (env: PORT, default 3000)
  --host <addr>  address to listen on (env: HOST, default 127.0.0.1)
  -h, --help     show this help
  -v, --version  show the version

Settings come from environment variables, or from a .env file in the current
directory. Real environment variables win over .env, and flags win over both.
PORT and HOST are shown above; the other settings are documented in the README.
`;

/** Print a message to stderr and exit with code 1. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: true,
  }));
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (values.version) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

let config;
try {
  const envFile = join(process.cwd(), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  config = loadConfig(process.env, { port: values.port, host: values.host });
} catch (err) {
  fail(err.message);
}

const app = createPastePage(config);

let stopping = false;
/** Close the server on the first signal; a second signal while closing forces exit code 1. */
async function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  await app.close();
  console.log('PastePage stopped');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

let url;
try {
  url = await app.listen();
} catch (err) {
  fail(`Cannot listen on ${config.host}:${config.port}: ${err.message}`);
}
console.log(`PastePage running at ${url}`);

