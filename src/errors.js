// Error codes shared by the HTTP API and the WebSocket, with their HTTP status.

/** Map of error code to HTTP status. The response body is always {"error": "<CODE>"}. */
export const ERRORS = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  LOCKED: 429,
  RATE_LIMITED: 429,
  TAKEN: 409,
  TOO_LARGE: 413,
  SESSION_FULL: 413,
  SERVER_FULL: 503,
  GONE: 410,
  FORBIDDEN: 403,
  METHOD: 405,
  INTERNAL: 500,
};

/** An error that carries a known protocol code and its HTTP status. */
export class AppError extends Error {
  /**
   * @param {string} code one of the keys of ERRORS; anything else throws
   */
  constructor(code) {
    if (!Object.hasOwn(ERRORS, code)) throw new Error(`Unknown error code: "${code}"`);
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = ERRORS[code];
  }
}
