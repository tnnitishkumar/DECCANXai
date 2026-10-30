import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, computeCostUsd, type BudgetAlert, type NewLedgerEntry } from "./index.ts";

const base = (o: Partial<NewLedgerEntry> = {}): NewLedgerEntry => ({
  requestId: "r1",
  provider: "p",
  model: "m",
  status: "ok",
  inputTokens: 100,
  outputTokens: 50,
  tokenProvenance: "measured",
  latencyMs: 200,
  ...o,
});

describe("computeCostUsd", () => {
  it("computes from per-million prices", () => {
    assert.equal(computeCostUsd(1_000_000, 500_000, 2, 10), 7);
  });
  it("returns undefined (not 0) when a price is unknown", () => {
    assert.equal(computeCostUsd(100, 100, undefined, 10), undefined);
    assert.equal(computeCostUsd(100, 100, 1, undefined), undefined);
  });
});

describe("UsageLedger summary", () => {
  it("is all zeros / null when empty (nothing fabricated)", () => {
    const s = new UsageLedger().summary();
    assert.equal(s.total.requests, 0);
    assert.equal(s.total.avgLatencyMs, null);
    assert.equal(s.total.estimatedCostUsd, 0);
  });

  it("keeps measured and estimated tokens separate", () => {
    const l = new UsageLedger();
    l.record(base({ inputTokens: 10, outputTokens: 5, tokenProvenance: "measured" }));
    l.record(base({ inputTokens: 7, outputTokens: 3, tokenProvenance: "estimated" }));
    const t = l.summary().total.tokens;
    assert.deepEqual(t.input, { measured: 10, estimated: 7 });
    assert.deepEqual(t.output, { measured: 5, estimated: 3 });
  });

  it("counts unpriced successes instead of treating them as free", () => {
    const l = new UsageLedger();
    l.record(base({ costUsd: 0.5 }));
    l.record(base());
    const t = l.summary().total;
    assert.equal(t.estimatedCostUsd, 0.5);
    assert.equal(t.unpricedRequests, 1);
  });

  it("tracks failures and groups by provider and model", () => {
    const l = new UsageLedger();
    l.record(base({ provider: "a", model: "x" }));
    l.record(base({ provider: "a", model: "y", status: "error", errorKind: "rate_limited", inputTokens: 0, outputTokens: 0 }));
    l.record(base({ provider: "b", model: "x" }));
    const s = l.summary();
    assert.equal(s.total.failedRequests, 1);
    assert.equal(s.byProvider["a"]?.requests, 2);
    assert.equal(s.byModel["a/y"]?.failedRequests, 1);
    assert.equal(s.byModel["b/x"]?.requests, 1);
  });
});

describe("UsageLedger budgets", () => {
  it("blocks once a token budget is reached, scoped to the provider", () => {
    const l = new UsageLedger();
    l.setBudgets([{ id: "pa", scope: { provider: "a" }, window: "day", maxTokens: 200 }]);
    assert.equal(l.checkBudget("a", "x").ok, true);
    l.record(base({ provider: "a", inputTokens: 120, outputTokens: 80 }));
    const c = l.checkBudget("a", "x");
    assert.equal(c.ok, false);
    assert.equal(l.checkBudget("b", "x").ok, true); // other provider unaffected
  });

  it("enforces request and cost limits", () => {
    const l = new UsageLedger();
    l.setBudgets([
      { id: "req", scope: {}, window: "day", maxRequests: 2 },
      { id: "cost", scope: { model: "m" }, window: "day", maxCostUsd: 1 },
    ]);
    l.record(base({ costUsd: 0.6 }));
    assert.equal(l.checkBudget("p", "m").ok, true);
    l.record(base({ costUsd: 0.5 }));
    const c = l.checkBudget("p", "m");
    assert.equal(c.ok, false);
  });

  it("resets when the window rolls over", () => {
    let now = Date.UTC(2026, 0, 1, 23, 0);
    const l = new UsageLedger({ now: () => now });
    l.setBudgets([{ id: "d", scope: {}, window: "day", maxRequests: 1 }]);
    l.record(base());
    assert.equal(l.checkBudget("p", "m").ok, false);
    now = Date.UTC(2026, 0, 2, 0, 1); // next UTC day
    assert.equal(l.checkBudget("p", "m").ok, true);
  });

  it("emits a warning at 80% and exceeded at 100%, once each per window", () => {
    const alerts: BudgetAlert[] = [];
    const l = new UsageLedger({ onAlert: (a) => alerts.push(a) });
    l.setBudgets([{ id: "t", scope: {}, window: "month", maxTokens: 1000 }]);
    l.record(base({ inputTokens: 500, outputTokens: 300 })); // 800 = 80%
    l.record(base({ inputTokens: 10, outputTokens: 10 })); // still warning, no duplicate
    l.record(base({ inputTokens: 100, outputTokens: 100 })); // 1020 >= limit
    assert.deepEqual(alerts.map((a) => a.level), ["warning", "exceeded"]);
  });
});
