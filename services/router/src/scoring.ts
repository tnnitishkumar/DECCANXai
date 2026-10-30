import type { Capability, ChatRequest, ModelRecord } from "#shared";
import { computeCostUsd } from "#usage";
import type { BreakerState } from "./breaker.ts";
import type { QualityTable } from "./quality.ts";

/**
 * Pure, deterministic routing score (ADR D9).
 *
 *   eligible(m) = state ok AND capabilities ⊇ required AND context fits
 *                 AND breaker != open AND budget ok          (hard filters)
 *   score(m)    = wq*quality + wr*reliability - wc*costNorm - wl*latencyNorm + wu*priority
 *
 * Hard constraints are filters, never weights, so a cost/budget cap cannot be outscored.
 * "Premium-first" is just a weight profile.
 */

export interface WeightProfile {
  quality: number;
  reliability: number;
  cost: number;
  latency: number;
  userPriority: number;
}

export const PROFILES = {
  premiumFirst: { quality: 1.0, reliability: 0.4, cost: 0.05, latency: 0.05, userPriority: 0.3 },
  balanced: { quality: 0.6, reliability: 0.4, cost: 0.3, latency: 0.2, userPriority: 0.3 },
  costSaver: { quality: 0.3, reliability: 0.3, cost: 0.8, latency: 0.2, userPriority: 0.3 },
} as const satisfies Record<string, WeightProfile>;

export interface CandidateStats {
  successes: number;
  attempts: number;
  /** Exponentially weighted moving average of observed latency; undefined until measured. */
  latencyEwmaMs?: number;
}

export interface Candidate {
  record: ModelRecord;
  breaker: BreakerState;
  budget: { ok: true } | { ok: false; reason: string };
  stats: CandidateStats;
  /** Operator priority for the provider, expected within [0,1]. */
  priority: number;
  /** Explicitly requested by the caller: bypasses the access-state filter only. */
  pinned?: boolean;
}

export interface ScoreComponents {
  quality: number;
  reliability: number;
  costNorm: number;
  costKnown: boolean;
  estCostUsd?: number;
  latencyNorm: number;
  priority: number;
}

export interface ScoreRow {
  key: string;
  provider: string;
  model: string;
  eligible: boolean;
  /** Why it was filtered out (empty when eligible). */
  reasons: string[];
  /** Non-blocking observations, e.g. unknown context window. */
  notes: string[];
  score?: number;
  components?: ScoreComponents;
}

export function estimateInputTokens(req: ChatRequest, est: (t: string) => number): number {
  return req.messages.reduce((n, m) => n + est(m.content), 0);
}

const ASSUMED_OUTPUT_TOKENS = 512;

export function scoreCandidates(args: {
  req: ChatRequest;
  estInputTokens: number;
  candidates: Candidate[];
  quality: QualityTable;
  weights: WeightProfile;
}): ScoreRow[] {
  const { req, estInputTokens, candidates, quality, weights } = args;
  const required: Capability[] = req.requires ?? [];
  const taskClass = req.taskClass ?? "general";
  const outTokens = req.maxTokens ?? ASSUMED_OUTPUT_TOKENS;

  const rows: ScoreRow[] = [];
  const eligibleData: Array<{ row: ScoreRow; c: Candidate; cost?: number }> = [];

  for (const c of candidates) {
    const r = c.record;
    const row: ScoreRow = {
      key: `${r.provider}/${r.modelId}`,
      provider: r.provider,
      model: r.modelId,
      eligible: true,
      reasons: [],
      notes: [],
    };
    if (!c.pinned && r.state !== "accessible" && r.state !== "tested") {
      row.reasons.push(`state '${r.state}' (needs a successful probe or served request)`);
    }
    if (r.state === "unavailable") row.reasons.push("marked unavailable");
    for (const cap of required) {
      if (!r.capabilities.includes(cap)) row.reasons.push(`missing capability '${cap}'`);
    }
    const needCtx = estInputTokens + (req.maxTokens ?? 0);
    if (r.contextWindow === undefined) row.notes.push("context window unknown");
    else if (r.contextWindow < needCtx) row.reasons.push(`context window ${r.contextWindow} < required ~${needCtx}`);
    if (c.breaker === "open") row.reasons.push("circuit breaker open");
    if (!c.budget.ok) row.reasons.push(`budget: ${c.budget.reason}`);

    row.eligible = row.reasons.length === 0;
    rows.push(row);
    if (row.eligible) {
      const cost = computeCostUsd(estInputTokens, outTokens, r.inputPricePerM, r.outputPricePerM);
      eligibleData.push({ row, c, ...(cost !== undefined ? { cost } : {}) });
    }
  }

  const maxCost = Math.max(0, ...eligibleData.map((d) => d.cost ?? 0));
  const maxLat = Math.max(0, ...eligibleData.map((d) => d.c.stats.latencyEwmaMs ?? 0));

  for (const { row, c, cost } of eligibleData) {
    const q = quality.tierFor(c.record.provider, c.record.modelId, taskClass);
    // Beta(1,1) prior: unseen models start at 0.5 rather than an unearned 1.0.
    const reliability = (c.stats.successes + 1) / (c.stats.attempts + 2);
    const costNorm = cost !== undefined && maxCost > 0 ? cost / maxCost : 0;
    const latencyNorm = c.stats.latencyEwmaMs !== undefined && maxLat > 0 ? c.stats.latencyEwmaMs / maxLat : 0;
    const score =
      weights.quality * q +
      weights.reliability * reliability -
      weights.cost * costNorm -
      weights.latency * latencyNorm +
      weights.userPriority * c.priority;
    row.score = score;
    row.components = {
      quality: q,
      reliability,
      costNorm,
      costKnown: cost !== undefined,
      ...(cost !== undefined ? { estCostUsd: cost } : {}),
      latencyNorm,
      priority: c.priority,
    };
  }

  return rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.eligible && b.eligible && a.score !== b.score) return (b.score ?? 0) - (a.score ?? 0);
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}
