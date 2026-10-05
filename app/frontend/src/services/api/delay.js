// Simulated network latency for mock service calls.
// Every mock read awaits delay(). Every mock write also awaits delay().

const FAIL_RATE = parseFloat(import.meta.env.VITE_MOCK_FAIL_RATE ?? '0');

/**
 * Returns a promise that resolves after a random delay between min and max ms.
 * @param {number} min - minimum ms (default 150)
 * @param {number} max - maximum ms (default 600)
 */
export function delay(min = 150, max = 600) {
  const ms = min + Math.random() * (max - min);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * MockApiError is thrown by maybeFail() when the random failure rate is hit.
 */
export class MockApiError extends Error {
  constructor(message = 'Mock API failure') {
    super(message);
    this.name = 'MockApiError';
    this.status = 500;
  }
}

/**
 * Optionally throws a MockApiError based on the configured fail rate.
 * Rate is read from VITE_MOCK_FAIL_RATE (default 0 — never fails in dev).
 * Set to 0.1 to get ~10% failure rate for testing error UI.
 * @param {{ rate?: number }} options
 */
export function maybeFail({ rate = FAIL_RATE } = {}) {
  if (rate > 0 && Math.random() < rate) {
    throw new MockApiError();
  }
}
