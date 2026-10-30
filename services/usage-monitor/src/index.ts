import type { Provenance } from "#shared";

/**
 * Usage ledger (spec sections 3 and 15).
 *
 * Rules enforced here:
 *  - token counts carry a provenance: "measured" (provider reported) or "estimated" (local);
 *  - cost is only computed when a price is known; unknown price => costUsd undefined, never 0-as-fact;
 *  - nothing is ever invented: an empty ledger summarises to zeros.
 *
 * v0.1 keeps the ledger in memory behind this class. Durable storage arrives with the
 * database phase; see docs/STATUS.md (known limitation).
 */

export interface LedgerEntry {
  id: number;
  ts: number;
  requestId: string;
  provider: string;
  model: string;
  status: "ok" | "error";
  errorKind?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  tokenProvenance: Provenance;
  /** Estimated from listed per-million prices. Undefined when price unknown. */
  costUsd?: number;
  latencyMs: number;
}

export type NewLedgerEntry = Omit<LedgerEntry, "id" | "ts"> & { ts?: number };

export interface BudgetRule {
  id: string;
  /** Empty scope = global. */
  scope: { provider?: string; model?: string };
  window: "day" | "month";
  maxTokens?: number;
  maxCostUsd?: number;
  maxRequests?: number;
}

export interface BudgetAlert {
  ruleId: string;
  level: "warning" | "exceeded";
  metric: "tokens" | "cost" | "requests";
  used: number;
  limit: number;
}

export type BudgetCheck = { ok: true } | { ok: false; ruleId: string; reason: string };

export function computeCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPricePerM?: number,
  outputPricePerM?: number,
): number | undefined {
  if (inputPricePerM === undefined || outputPricePerM === undefined) return undefined;
  return (inputTokens * inputPricePerM + outputTokens * outputPricePerM) / 1_000_000;
}

function windowStart(window: "day" | "month", now: number): number {
  const d = new Date(now);
  return window === "day"
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

interface Bucket {
  requests: number;
  failed: number;
  inputMeasured: number;
  inputEstimated: number;
  outputMeasured: number;
  outputEstimated: number;
  costUsd: number;
  unpricedRequests: number;
  latencySum: number;
}

function emptyBucket(): Bucket {
  return {
    requests: 0,
    failed: 0,
    inputMeasured: 0,
    inputEstimated: 0,
    outputMeasured: 0,
    outputEstimated: 0,
    costUsd: 0,
    unpricedRequests: 0,
    latencySum: 0,
  };
}

function add(b: Bucket, e: LedgerEntry): void {
  b.requests++;
  if (e.status === "error") b.failed++;
  if (e.tokenProvenance === "measured") {
    b.inputMeasured += e.inputTokens;
    b.outputMeasured += e.outputTokens;
  } else {
    b.inputEstimated += e.inputTokens;
    b.outputEstimated += e.outputTokens;
  }
  if (e.status === "ok") {
    if (e.costUsd === undefined) b.unpricedRequests++;
    else b.costUsd += e.costUsd;
  }
  b.latencySum += e.latencyMs;
}

export interface UsageSummary {
  requests: number;
  failedRequests: number;
  tokens: {
    input: { measured: number; estimated: number };
    output: { measured: number; estimated: number };
  };
  /** Always an estimate from listed prices; excludes requests whose price is unknown. */
  estimatedCostUsd: number;
  unpricedRequests: number;
  avgLatencyMs: number | null;
}

function toSummary(b: Bucket): UsageSummary {
  return {
    requests: b.requests,
    failedRequests: b.failed,
    tokens: {
      input: { measured: b.inputMeasured, estimated: b.inputEstimated },
      output: { measured: b.outputMeasured, estimated: b.outputEstimated },
    },
    estimatedCostUsd: b.costUsd,
    unpricedRequests: b.unpricedRequests,
    avgLatencyMs: b.requests === 0 ? null : b.latencySum / b.requests,
  };
}

export class UsageLedger {
  private entries: LedgerEntry[] = [];
  private nextId = 1;
  private rules: BudgetRule[] = [];
  private alerted = new Set<string>();
  private readonly now: () => number;
  private readonly onAlert: ((a: BudgetAlert) => void) | undefined;

  constructor(opts: { now?: () => number; onAlert?: (a: BudgetAlert) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.onAlert = opts.onAlert;
  }

  setBudgets(rules: BudgetRule[]): void {
    this.rules = [...rules];
  }

  getBudgets(): BudgetRule[] {
    return [...this.rules];
  }

  record(e: NewLedgerEntry): LedgerEntry {
    const entry: LedgerEntry = { ...e, id: this.nextId++, ts: e.ts ?? this.now() };
    this.entries.push(entry);
    this.evaluateAlerts(entry);
    return entry;
  }

  private matches(rule: BudgetRule, provider: string, model: string): boolean {
    if (rule.scope.provider !== undefined && rule.scope.provider !== provider) return false;
    if (rule.scope.model !== undefined && rule.scope.model !== model) return false;
    return true;
  }

  private usedInWindow(rule: BudgetRule, at: number) {
    const start = windowStart(rule.window, at);
    let tokens = 0;
    let cost = 0;
    let requests = 0;
    for (const e of this.entries) {
      if (e.ts < start) continue;
      if (!this.matches(rule, e.provider, e.model)) continue;
      requests++;
      tokens += e.inputTokens + e.outputTokens;
      if (e.costUsd !== undefined) cost += e.costUsd;
    }
    return { tokens, cost, requests };
  }

  /** Called before dispatching to a provider/model. Hard stop when any rule is exhausted. */
  checkBudget(provider: string, model: string): BudgetCheck {
    const at = this.now();
    for (const rule of this.rules) {
      if (!this.matches(rule, provider, model)) continue;
      const u = this.usedInWindow(rule, at);
      if (rule.maxRequests !== undefined && u.requests >= rule.maxRequests) {
        return { ok: false, ruleId: rule.id, reason: `request limit reached (${u.requests}/${rule.maxRequests} per ${rule.window})` };
      }
      if (rule.maxTokens !== undefined && u.tokens >= rule.maxTokens) {
        return { ok: false, ruleId: rule.id, reason: `token budget reached (${u.tokens}/${rule.maxTokens} per ${rule.window})` };
      }
      if (rule.maxCostUsd !== undefined && u.cost >= rule.maxCostUsd) {
        return { ok: false, ruleId: rule.id, reason: `cost budget reached ($${u.cost.toFixed(4)}/$${rule.maxCostUsd} per ${rule.window})` };
      }
    }
    return { ok: true };
  }

  private evaluateAlerts(e: LedgerEntry): void {
    if (!this.onAlert) return;
    for (const rule of this.rules) {
      if (!this.matches(rule, e.provider, e.model)) continue;
      const u = this.usedInWindow(rule, e.ts);
      const start = windowStart(rule.window, e.ts);
      const metrics: Array<[BudgetAlert["metric"], number, number | undefined]> = [
        ["tokens", u.tokens, rule.maxTokens],
        ["cost", u.cost, rule.maxCostUsd],
        ["requests", u.requests, rule.maxRequests],
      ];
      for (const [metric, used, limit] of metrics) {
        if (limit === undefined || limit <= 0) continue;
        const level = used >= limit ? "exceeded" : used >= 0.8 * limit ? "warning" : undefined;
        if (!level) continue;
        const key = `${rule.id}:${metric}:${level}:${start}`;
        if (this.alerted.has(key)) continue;
        this.alerted.add(key);
        this.onAlert({ ruleId: rule.id, level, metric, used, limit });
      }
    }
  }

  history(limit = 100): LedgerEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  summary(filter: { sinceTs?: number } = {}) {
    const total = emptyBucket();
    const byProvider = new Map<string, Bucket>();
    const byModel = new Map<string, Bucket>();
    for (const e of this.entries) {
      if (filter.sinceTs !== undefined && e.ts < filter.sinceTs) continue;
      add(total, e);
      add(byProvider.get(e.provider) ?? byProvider.set(e.provider, emptyBucket()).get(e.provider)!, e);
      const mk = `${e.provider}/${e.model}`;
      add(byModel.get(mk) ?? byModel.set(mk, emptyBucket()).get(mk)!, e);
    }
    return {
      total: toSummary(total),
      byProvider: Object.fromEntries([...byProvider].map(([k, v]) => [k, toSummary(v)])),
      byModel: Object.fromEntries([...byModel].map(([k, v]) => [k, toSummary(v)])),
    };
  }
}
