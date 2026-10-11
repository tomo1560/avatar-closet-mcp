/** Retries after the first attempt, so a request is sent at most MAX_RETRIES + 1 times. */
export const MAX_RETRIES = 3;
export const BASE_BACKOFF_MS = 2_000;
export const MAX_RETRY_AFTER_MS = 30_000;

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/**
 * Delay before retry number `retryIndex` (0-based): 2s, 4s, 8s.
 * A server-provided Retry-After (seconds or HTTP-date) is honoured when it asks for longer,
 * capped at 30 seconds.
 */
export function backoffDelayMs(retryIndex: number, retryAfter: string | undefined, nowMs: number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** retryIndex;
  const requested = parseRetryAfterMs(retryAfter, nowMs);
  if (requested === undefined) return exponential;
  return Math.max(exponential, Math.min(requested, MAX_RETRY_AFTER_MS));
}

function parseRetryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
