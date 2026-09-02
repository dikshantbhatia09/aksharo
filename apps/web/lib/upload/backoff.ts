/**
 * Exponential backoff with full jitter, shared by every retry loop in the
 * upload engine — the same shape `@montaj/api-client`'s realtime client uses,
 * so a restarting API or a MinIO blip is met with staggered retries rather
 * than a thundering herd of parts all retrying on the same tick.
 */
const BASE_MS = 500;
const MAX_MS = 15_000;

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BASE_MS * 2 ** Math.max(0, attempt - 1), MAX_MS);
  return Math.round(exponential * (0.5 + random() * 0.5));
}
