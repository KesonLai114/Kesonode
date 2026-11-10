// ─── Exponential Backoff Retry ─────────────────────────────────────────────

/** Error carrying an HTTP status so retry logic can tell transient from terminal. */
export class HttpError extends Error {
  /**
   * The server is metering us, not refusing this one request: a 429 anywhere, or
   * Nutstore's 403 standing in for one. Automatic sync parks itself for a whole
   * window when it sees this, instead of spending the next window's quota too.
   */
  constructor(
    public readonly status: number,
    message?: string,
    public readonly rateLimited = false,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
  }
}

/**
 * What to say when the storage answers 429 Too Many Requests.
 *
 * Every backend said "HTTP 429" or "WebDAV PUT failed: 429" and nothing else, which tells
 * someone it failed and not what to do (reported on appinn, 2026-09-10: "keeps returning
 * HTTP 429, tried several, none work"). A provider that meters requests, Nutstore's 600 per
 * 30 minutes the best known, is the usual reason, and the one lever the user holds is the
 * sync interval. Cure first, status last: the popup shows two lines of this.
 */
export function rateLimitMessage(where: string): string {
  return `Too many requests: ${where} is turning Kesonode away for a while. Raise Sync interval in Settings → Device to stay under its limit. (HTTP 429)`;
}

/** Retry only transient failures: network errors and HTTP 408/423/429/5xx. */
export function defaultShouldRetry(err: Error): boolean {
  if (err instanceof HttpError) {
    // 423 Locked is WebDAV's "something else is writing this right now", which is the
    // definition of transient: the lock clears on its own. Koofr returns it when two
    // writes to one file overlap, and it reached a user as "WebDAV PUT failed: 423" on a
    // burst of conflict resolutions. The backend already treats a 423 from MKCOL as
    // benign; a 423 from PUT is the same fact about the same server, and the one thing to
    // do with it is come back in a moment.
    return err.status === 408 || err.status === 423 || err.status === 429 || err.status >= 500;
  }
  // fetch() rejects with a TypeError on network/CORS failures — treat as transient.
  // But a bare `TypeError` is also how programming bugs surface (e.g. "x is not a
  // function"); retrying those just burns ~90s of backoff and hides the real stack.
  // Only retry TypeErrors whose message looks like a network failure.
  if (err.name === "TypeError") return /fetch|network|load failed/i.test(err.message);
  return false;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetry?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    jitter = true,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = options;

  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Stop immediately on terminal errors (e.g. 401/403/404) — retrying a
      // deterministic failure just wastes time and rate-limit budget.
      if (attempt === maxAttempts || !shouldRetry(lastError)) break;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const finalDelay = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;

      onRetry?.(attempt, lastError);
      await sleep(finalDelay);
    }
  }

  throw lastError;
}

/**
 * One short extra attempt for a SINGLE peer-file GET.
 *
 * The listing already has its own full retry (withRetry around downloadAll), but a peer
 * file that answered 503 used to be dropped on the first try, and the sync still reported
 * success. A 503 from a NAS or a metered WebDAV is often a one-off; retrying just this
 * file costs a fraction of a second and does not re-run the whole listing. Terminal
 * statuses (401/403/404) are not retried — defaultShouldRetry already excludes them.
 */
export function withPeerRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 500, jitter: false });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
