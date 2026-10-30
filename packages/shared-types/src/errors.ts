export type ErrorKind =
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "auth"
  | "bad_request"
  | "budget_exceeded"
  | "no_candidates"
  | "unknown";

export class DeccanError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  /** Seconds the provider asked us to wait (Retry-After), if any. */
  readonly retryAfterSec?: number;

  constructor(kind: ErrorKind, message: string, opts: { status?: number; retryAfterSec?: number } = {}) {
    super(message);
    this.name = "DeccanError";
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
  }

  /** Retryable on the same provider (after backoff) or by failing over. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "timeout";
  }
}

export function errorFromStatus(status: number, message: string, retryAfterSec?: number): DeccanError {
  const opts = retryAfterSec !== undefined ? { status, retryAfterSec } : { status };
  if (status === 429) return new DeccanError("rate_limited", message, opts);
  if (status === 401 || status === 403) return new DeccanError("auth", message, opts);
  if (status === 408) return new DeccanError("timeout", message, opts);
  if (status >= 500) return new DeccanError("unavailable", message, opts);
  if (status >= 400) return new DeccanError("bad_request", message, opts);
  return new DeccanError("unknown", message, opts);
}
