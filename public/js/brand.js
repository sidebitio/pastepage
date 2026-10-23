// Brand constants and a safe wrapper around browser storage (all keys get the pastepage- prefix).

/** Product name shown in the UI and the tab title. */
export const APP_NAME = 'PastePage';
/** Creator's site, linked from the credit line. */
export const SITE_URL = 'https://sidebit.io';

const PREFIX = 'pastepage-';

/** Look up a storage area by name; throws if blocked (callers catch). */
const area_ = (area) => globalThis[area];

/**
 * Storage helpers. Every call is wrapped in try/catch so blocked or missing storage never throws.
 * `area` is 'localStorage' or 'sessionStorage'; keys are prefixed automatically.
 */
export const storage = {
  /**
   * Read a value.
   * @param {string} area 'localStorage' or 'sessionStorage'
   * @param {string} key key without the prefix
   * @returns {string|null} the stored value, or null if missing or storage is unavailable
   */
  get(area, key) {
    try { return area_(area).getItem(PREFIX + key); } catch { return null; }
  },
  /**
   * Write a value; silently does nothing if storage is unavailable.
   * @param {string} area 'localStorage' or 'sessionStorage'
   * @param {string} key key without the prefix
   * @param {string} value value to store
   * @returns {void}
   */
  set(area, key, value) {
    try { area_(area).setItem(PREFIX + key, value); } catch { /* storage blocked */ }
  },
  /**
   * Remove a value; silently does nothing if storage is unavailable.
   * @param {string} area 'localStorage' or 'sessionStorage'
   * @param {string} key key without the prefix
   * @returns {void}
   */
  del(area, key) {
    try { area_(area).removeItem(PREFIX + key); } catch { /* storage blocked */ }
  },
};
