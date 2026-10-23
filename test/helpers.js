// Test helpers: start a PastePage server on a random port and post to its JSON API.
import { loadConfig } from '../src/config.js';
import { createPastePage } from '../src/server.js';

/**
 * Start a server on 127.0.0.1 with a random port.
 * @param {object} [overrides] config overrides
 * @param {object} [opts] options for createPastePage (publicDir, now)
 * @returns {Promise<{url: string, app: object}>} base URL with trailing slash, and the app
 */
export async function start(overrides = {}, opts = {}) {
  const config = { ...loadConfig({}), port: 0, ...overrides };
  const app = createPastePage(config, opts);
  const url = await app.listen();
  return { url, app };
}

/**
 * POST a JSON body to an API action.
 * @param {string} url base URL with trailing slash
 * @param {string} action API action name
 * @param {unknown} body JSON-serialisable body, or a string sent as is
 * @param {Record<string, string>} [headers] extra request headers
 * @returns {Promise<{status: number, data: any}>}
 */
export async function post(url, action, body, headers = {}) {
  const res = await fetch(`${url}api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
