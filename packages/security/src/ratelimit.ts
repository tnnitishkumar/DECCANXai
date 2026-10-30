/** Fixed-window per-principal rate limiter (in-memory; single-process). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  take(id: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    let w = this.windows.get(id);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.windows.set(id, w);
      if (this.windows.size > 10_000) this.prune(t);
    }
    if (w.count >= this.limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) };
    w.count++;
    return { ok: true };
  }

  private prune(t: number): void {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
