// Errors every op may raise. `code` is stable and machine-readable; `message` is written for
// the agent (what went wrong and what to do next); `details` carries structured context.
// Nothing secret ever goes into an OpError (tokens, passwords, setup codes).

export class OpError extends Error {
  /**
   * @param {string} code     invalid_input | not_found | refused | conflict | unavailable |
   *                          app_error | rate_limited | not_configured | needs_provisioning
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

export const invalid = (message, details) => new OpError('invalid_input', message, details);
export const notFound = (message, details) => new OpError('not_found', message, details);
export const refused = (message, details) => new OpError('refused', message, details);

/** Turn anything thrown into the `{ code, message, details? }` shape returned to callers. */
export function errorPayload(e) {
  if (e instanceof OpError) return e.toJSON();
  return { code: 'internal', message: (e && e.message) ? String(e.message) : String(e) };
}
