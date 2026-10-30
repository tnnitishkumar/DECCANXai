export type BreakerState = "closed" | "open" | "half_open";

interface Entry {
  failures: number;
  openedAt?: number;
  trialInFlight: boolean;
}

/**
 * Per-key circuit breaker. closed -> (N consecutive failures) -> open -> (cooldown) ->
 * half_open (exactly one trial request) -> closed on success / open again on failure.
 */
export class CircuitBreaker {
  private entries = new Map<string, Entry>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { failures: 0, trialInFlight: false };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Non-mutating view used for eligibility scoring. */
  state(key: string): BreakerState {
    const e = this.entries.get(key);
    if (!e || e.openedAt === undefined) return "closed";
    return this.now() - e.openedAt >= this.cooldownMs ? "half_open" : "open";
  }

  /** Called immediately before dispatch. In half_open only a single trial is admitted. */
  allow(key: string): boolean {
    const s = this.state(key);
    if (s === "closed") return true;
    if (s === "open") return false;
    const e = this.entry(key);
    if (e.trialInFlight) return false;
    e.trialInFlight = true;
    return true;
  }

  onSuccess(key: string): void {
    const e = this.entry(key);
    e.failures = 0;
    delete e.openedAt;
    e.trialInFlight = false;
  }

  onFailure(key: string): void {
    const e = this.entry(key);
    e.trialInFlight = false;
    e.failures++;
    if (e.openedAt !== undefined || e.failures >= this.threshold) e.openedAt = this.now();
  }
}
