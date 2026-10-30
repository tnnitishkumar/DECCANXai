import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResponse, ModelRecord, ProviderAdapter, StreamChunk, Usage } from "#shared";
import { DeccanError, redact } from "#shared";
import { estimateTokens } from "#adapters";
import type { ModelRegistry } from "#registry";
import { UsageLedger, computeCostUsd } from "#usage";
import { CircuitBreaker } from "./breaker.ts";
import { QualityTable } from "./quality.ts";
import {
  PROFILES,
  estimateInputTokens,
  scoreCandidates,
  type Candidate,
  type CandidateStats,
  type ScoreRow,
  type WeightProfile,
} from "./scoring.ts";

export interface RetryPolicy {
  /** Attempts on one candidate before failing over (>=1). */
  maxAttemptsPerCandidate: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RouterOptions {
  adapters: ProviderAdapter[];
  registry: ModelRegistry;
  ledger: UsageLedger;
  quality?: QualityTable;
  weights?: WeightProfile;
  breaker?: CircuitBreaker;
  retry?: Partial<RetryPolicy>;
  /** Provider priority in [0,1]; higher is preferred (user-defined priorities). */
  providerPriority?: Record<string, number>;
  /** How many ranked candidates may be tried (failover depth). */
  maxCandidates?: number;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface RoutingAttempt {
  provider: string;
  model: string;
  outcome: "ok" | "error" | "skipped";
  errorKind?: string;
  message?: string;
  latencyMs?: number;
}

export interface RoutingDecision {
  requestId: string;
  requested: string;
  /** Full candidate score table: every model considered, why it was filtered, and its score. */
  table: ScoreRow[];
  attempts: RoutingAttempt[];
  chosen?: { provider: string; model: string };
}

export interface RouteResult {
  response: ChatResponse;
  decision: RoutingDecision;
}

type FailureAction = { err: DeccanError; action: "throw" | "next" | "retry"; waitMs: number };

export class Router {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly registry: ModelRegistry;
  private readonly ledger: UsageLedger;
  private readonly quality: QualityTable;
  private readonly weights: WeightProfile;
  private readonly breaker: CircuitBreaker;
  private readonly retry: RetryPolicy;
  private readonly priority: Record<string, number>;
  private readonly maxCandidates: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly stats = new Map<string, CandidateStats>();
  private readonly decisions: RoutingDecision[] = [];

  constructor(o: RouterOptions) {
    for (const a of o.adapters) this.adapters.set(a.id, a);
    this.registry = o.registry;
    this.ledger = o.ledger;
    this.quality = o.quality ?? new QualityTable();
    this.weights = o.weights ?? PROFILES.premiumFirst;
    this.now = o.now ?? Date.now;
    this.breaker = o.breaker ?? new CircuitBreaker({ now: this.now });
    this.retry = { maxAttemptsPerCandidate: 2, baseDelayMs: 200, maxDelayMs: 5_000, ...o.retry };
    if (this.retry.maxAttemptsPerCandidate < 1) throw new Error("maxAttemptsPerCandidate must be >= 1");
    this.priority = o.providerPriority ?? {};
    this.maxCandidates = o.maxCandidates ?? 4;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.random ?? Math.random;
  }

  providerIds(): string[] {
    return [...this.adapters.keys()];
  }

  recentDecisions(limit = 50): RoutingDecision[] {
    return this.decisions.slice(-limit).reverse();
  }

  routingStats(): Record<string, CandidateStats> {
    return Object.fromEntries(this.stats);
  }

  // ---------------------------------------------------------------- planning

  private statsFor(key: string): CandidateStats {
    let s = this.stats.get(key);
    if (!s) {
      s = { successes: 0, attempts: 0 };
      this.stats.set(key, s);
    }
    return s;
  }

  private plan(req: ChatRequest): { rows: ScoreRow[]; byKey: Map<string, ModelRecord> } {
    const providers = this.providerIds();
    let records: ModelRecord[];
    let pinned = false;

    if (req.model === "auto" || req.model === "") {
      records = this.registry.list().filter((m) => this.adapters.has(m.provider));
    } else {
      pinned = true;
      const r = this.registry.resolve(req.model, providers);
      if ("error" in r) {
        const slash = req.model.indexOf("/");
        const p = slash > 0 ? req.model.slice(0, slash) : undefined;
        if (!p || !this.adapters.has(p)) throw new DeccanError("bad_request", r.error);
        // Explicit request for a model the catalogue never listed: the caller's choice, tried honestly.
        records = [
          { provider: p, modelId: req.model.slice(slash + 1), displayName: req.model.slice(slash + 1), capabilities: [], state: "configured" },
        ];
      } else {
        if (!this.adapters.has(r.provider)) throw new DeccanError("bad_request", `provider '${r.provider}' is not configured`);
        records = [r];
      }
    }

    const byKey = new Map<string, ModelRecord>();
    const candidates: Candidate[] = records.map((record) => {
      const key = `${record.provider}/${record.modelId}`;
      byKey.set(key, record);
      return {
        record,
        breaker: this.breaker.state(key),
        budget: (() => {
          const b = this.ledger.checkBudget(record.provider, record.modelId);
          return b.ok ? ({ ok: true } as const) : ({ ok: false, reason: b.reason } as const);
        })(),
        stats: { ...this.statsFor(key) },
        priority: this.priority[record.provider] ?? 0,
        pinned,
      };
    });

    const rows = scoreCandidates({
      req,
      estInputTokens: estimateInputTokens(req, estimateTokens),
      candidates,
      quality: this.quality,
      weights: this.weights,
    });
    return { rows, byKey };
  }

  private remember(d: RoutingDecision): void {
    this.decisions.push(d);
    if (this.decisions.length > 200) this.decisions.shift();
  }

  private noCandidates(rows: ScoreRow[]): DeccanError {
    const why = rows.length === 0 ? "no models are registered" : rows.slice(0, 6).map((r) => `${r.key}: ${r.reasons.join("; ")}`).join(" | ");
    const allBudget = rows.length > 0 && rows.every((r) => r.reasons.some((x) => x.startsWith("budget:")));
    return new DeccanError(allBudget ? "budget_exceeded" : "no_candidates", `no eligible model (${why})`);
  }

  // ---------------------------------------------------------------- attempt bookkeeping

  /** Budget first (must not consume a half-open trial), then circuit breaker. */
  private gate(key: string, rec: ModelRecord): DeccanError | undefined {
    const b = this.ledger.checkBudget(rec.provider, rec.modelId);
    if (!b.ok) return new DeccanError("budget_exceeded", b.reason);
    if (!this.breaker.allow(key)) return new DeccanError("unavailable", `circuit breaker open for ${key}`);
    return undefined;
  }

  private succeeded(requestId: string, key: string, rec: ModelRecord, usage: Usage, latencyMs: number): void {
    this.breaker.onSuccess(key);
    const s = this.statsFor(key);
    s.successes++;
    s.attempts++;
    s.latencyEwmaMs = s.latencyEwmaMs === undefined ? latencyMs : 0.7 * s.latencyEwmaMs + 0.3 * latencyMs;
    const cost = computeCostUsd(usage.inputTokens, usage.outputTokens, rec.inputPricePerM, rec.outputPricePerM);
    this.ledger.record({
      requestId,
      provider: rec.provider,
      model: rec.modelId,
      status: "ok",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
      tokenProvenance: usage.provenance,
      ...(cost !== undefined ? { costUsd: cost } : {}),
      latencyMs,
    });
    this.registry.markServed(rec.provider, rec.modelId);
  }

  private backoffMs(attempt: number, err: DeccanError): number | "failover" {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt);
    const jittered = exp * (0.5 + 0.5 * this.random());
    if (err.retryAfterSec !== undefined) {
      const ra = err.retryAfterSec * 1000;
      if (ra > this.retry.maxDelayMs) return "failover"; // provider wants a long pause: don't stall the caller
      return Math.max(ra, jittered);
    }
    return jittered;
  }

  private failed(e: unknown, requestId: string, key: string, rec: ModelRecord, t0: number, attempt: number): FailureAction {
    const err = e instanceof DeccanError ? e : new DeccanError("unknown", redact((e as Error)?.message ?? "unknown error"));
    const latency = this.now() - t0;
    this.ledger.record({
      requestId,
      provider: rec.provider,
      model: rec.modelId,
      status: "error",
      errorKind: err.kind,
      inputTokens: 0,
      outputTokens: 0,
      tokenProvenance: "measured", // zero tokens were consumed, which we know
      latencyMs: latency,
    });
    if (err.kind === "bad_request") return { err, action: "throw", waitMs: 0 }; // request-specific; not the model's fault
    this.breaker.onFailure(key);
    const s = this.statsFor(key);
    s.attempts++;
    if (err.kind === "auth") {
      this.registry.markUnavailable(rec.provider, rec.modelId);
      return { err, action: "next", waitMs: 0 };
    }
    if (!err.retryable) return { err, action: "next", waitMs: 0 };
    if (attempt >= this.retry.maxAttemptsPerCandidate - 1) return { err, action: "next", waitMs: 0 };
    const w = this.backoffMs(attempt, err);
    if (w === "failover") return { err, action: "next", waitMs: 0 };
    return { err, action: "retry", waitMs: w };
  }

  private attemptRecord(rec: ModelRecord, outcome: RoutingAttempt["outcome"], extra: Partial<RoutingAttempt> = {}): RoutingAttempt {
    return { provider: rec.provider, model: rec.modelId, outcome, ...extra };
  }

  // ---------------------------------------------------------------- public API

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<RouteResult> {
    const requestId = randomUUID();
    const { rows, byKey } = this.plan(req);
    const decision: RoutingDecision = { requestId, requested: req.model, table: rows, attempts: [] };
    this.remember(decision);

    const order = rows.filter((r) => r.eligible).slice(0, this.maxCandidates);
    if (order.length === 0) throw this.noCandidates(rows);

    let last: DeccanError | undefined;
    for (const row of order) {
      const rec = byKey.get(row.key)!;
      const adapter = this.adapters.get(rec.provider)!;
      for (let attempt = 0; attempt < this.retry.maxAttemptsPerCandidate; attempt++) {
        if (signal?.aborted) throw new DeccanError("timeout", "request aborted by caller");
        const blocked = this.gate(row.key, rec);
        if (blocked) {
          last = blocked;
          decision.attempts.push(this.attemptRecord(rec, "skipped", { errorKind: blocked.kind, message: blocked.message }));
          break;
        }
        const t0 = this.now();
        try {
          const response = await adapter.chat(req, rec.modelId, signal);
          const latencyMs = this.now() - t0;
          this.succeeded(requestId, row.key, rec, response.usage, latencyMs);
          decision.attempts.push(this.attemptRecord(rec, "ok", { latencyMs }));
          decision.chosen = { provider: rec.provider, model: rec.modelId };
          return { response, decision };
        } catch (e) {
          const f = this.failed(e, requestId, row.key, rec, t0, attempt);
          decision.attempts.push(this.attemptRecord(rec, "error", { errorKind: f.err.kind, message: f.err.message, latencyMs: this.now() - t0 }));
          last = f.err;
          if (f.action === "throw") throw f.err;
          if (f.action === "next") break;
          await this.sleep(f.waitMs);
        }
      }
    }
    throw last ?? this.noCandidates(rows);
  }

  /**
   * Streaming. Failover/retry happen only BEFORE the first chunk is delivered: once bytes
   * have reached the caller we cannot transparently switch models, so a later failure is
   * recorded and surfaced as an error rather than silently restarted.
   */
  stream(req: ChatRequest, signal?: AbortSignal): { decision: RoutingDecision; chunks: AsyncGenerator<StreamChunk> } {
    const requestId = randomUUID();
    const { rows, byKey } = this.plan(req);
    const decision: RoutingDecision = { requestId, requested: req.model, table: rows, attempts: [] };
    this.remember(decision);
    const self = this;

    async function* run(): AsyncGenerator<StreamChunk> {
      const order = rows.filter((r) => r.eligible).slice(0, self.maxCandidates);
      if (order.length === 0) throw self.noCandidates(rows);

      let last: DeccanError | undefined;
      for (const row of order) {
        const rec = byKey.get(row.key)!;
        const adapter = self.adapters.get(rec.provider)!;
        for (let attempt = 0; attempt < self.retry.maxAttemptsPerCandidate; attempt++) {
          if (signal?.aborted) throw new DeccanError("timeout", "request aborted by caller");
          const blocked = self.gate(row.key, rec);
          if (blocked) {
            last = blocked;
            decision.attempts.push(self.attemptRecord(rec, "skipped", { errorKind: blocked.kind, message: blocked.message }));
            break;
          }
          const t0 = self.now();
          const gen = adapter.stream(req, rec.modelId, signal);
          let first: IteratorResult<StreamChunk>;
          try {
            first = await gen.next();
          } catch (e) {
            const f = self.failed(e, requestId, row.key, rec, t0, attempt);
            decision.attempts.push(self.attemptRecord(rec, "error", { errorKind: f.err.kind, message: f.err.message, latencyMs: self.now() - t0 }));
            last = f.err;
            if (f.action === "throw") throw f.err;
            if (f.action === "next") break;
            await self.sleep(f.waitMs);
            continue;
          }

          // Committed: from here on the caller has (or will have) received data from this model.
          decision.chosen = { provider: rec.provider, model: rec.modelId };
          let produced = "";
          let finalUsage: Usage | undefined;
          try {
            let cur = first;
            while (!cur.done) {
              const chunk = cur.value;
              produced += chunk.delta;
              if (chunk.usage) finalUsage = chunk.usage;
              yield chunk;
              cur = await gen.next();
            }
          } catch (e) {
            // Mid-stream failure after data was delivered: record it, surface it, never restart silently.
            const f = self.failed(e, requestId, row.key, rec, t0, self.retry.maxAttemptsPerCandidate);
            decision.attempts.push(self.attemptRecord(rec, "error", { errorKind: f.err.kind, message: f.err.message, latencyMs: self.now() - t0 }));
            throw f.err;
          }
          const usage: Usage =
            finalUsage ?? {
              inputTokens: req.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
              outputTokens: estimateTokens(produced),
              provenance: "estimated",
            };
          const latencyMs = self.now() - t0;
          self.succeeded(requestId, row.key, rec, usage, latencyMs);
          decision.attempts.push(self.attemptRecord(rec, "ok", { latencyMs }));
          return;
        }
      }
      throw last ?? self.noCandidates(rows);
    }

    return { decision, chunks: run() };
  }
}
