// Invite links: parse the URL hash (#id or #id/password), build links and the invite text. No DOM.
import { ID_RE, normId, normPass } from './words.js';

/** A session link's hash is far shorter than this; anything longer is not one (and would make the stripping slow). */
const MAX_HASH = 256;

/**
 * Parse a location hash such as "#12-dancing-apes/tq7m8kxph3vdr2".
 * Tolerates an encoded slash and punctuation that chat apps append.
 * @param {string} hash the hash, with or without the leading "#"
 * @returns {{id: string, pass: string}|null} pass is '' when absent; null if the id is invalid or the hash is
 *   longer than 256 characters
 */
export function parseHash(hash) {
  let s = String(hash || '').replace(/^#/, '');
  try { s = decodeURIComponent(s); } catch { /* keep the raw text */ }
  s = s.trim();
  if (s.length > MAX_HASH) return null;
  s = s.replace(/[^A-Za-z0-9]+$/, '');
  const slash = s.indexOf('/');
  const rawId = slash === -1 ? s : s.slice(0, slash);
  const rawPass = slash === -1 ? '' : s.slice(slash + 1);
  const id = normId(rawId);
  if (!ID_RE.test(id)) return null;
  return { id, pass: normPass(rawPass) };
}

/**
 * Read what was typed or pasted into the Join panel's session field: a whole invite link
 * ("https://host/path#12-dancing-apes/tq7m8kxph3vdr2"), just its hash, "id/password", or a session name.
 * @param {string} text the field's text
 * @returns {{id: string, pass: string}|null} pass is '' when the text has none; null if no valid session name is in it
 */
export function parseJoinInput(text) {
  const s = String(text || '').trim();
  const hash = s.indexOf('#');
  return parseHash(hash === -1 ? s : s.slice(hash + 1));
}

/**
 * Build a shareable link.
 * @param {string} base page URL without hash
 * @param {string} id session id
 * @param {string} [pass] password; omitted from the link when empty
 * @returns {string}
 */
export function inviteLink(base, id, pass) {
  return base + '#' + id + (pass ? '/' + pass : '');
}

/**
 * Build the invite message text through the translator.
 * @param {(key: string, vars?: object) => string} t translate function
 * @param {{base: string, id: string, pass: string}} parts
 * @returns {string}
 */
export function inviteText(t, { base, id, pass }) {
  return t('invite.text', { link: inviteLink(base, id, pass), base, id, pass });
}
