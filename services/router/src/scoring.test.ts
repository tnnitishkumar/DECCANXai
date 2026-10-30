import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Capability, ChatRequest, ModelRecord, ModelState } from "#shared";
import { PROFILES, scoreCandidates, type Candidate, type WeightProfile } from "./scoring.ts";
import { QualityTable } from "./quality.ts";

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({ model: "auto", messages: [{ role: "user", content: "x" }], ...o });

function cand(id: string, o: Omit<Partial<Candidate>, "record"> & { record?: Partial<ModelRecord> } = {}): Candidate {
  return {
    record: { provider: "p", modelId: id, displayName: id, capabilities: [], state: "accessible", ...o.record },
    breaker: o.breaker ?? "closed",
    budget: o.budget ?? { ok: true },
    stats: o.stats ?? { successes: 0, attempts: 0 },
    priority: o.priority ?? 0,
    ...(o.pinned ? { pinned: true } : {}),
  };
}

const quality = new QualityTable([
  { pattern: "p/top", tier: 0.95 },
  { pattern: "p/mid", tier: 0.6 },
  { pattern: "p/low", tier: 0.2 },
]);

describe("quality table", () => {
  it("uses first matching rule, task-class override and the neutral default", () => {
    const q = new QualityTable([{ pattern: "claude", tier: 0.9, taskClasses: { coding: 0.97 } }], 0.4);
    assert.equal(q.tierFor("anthropic", "Claude-X"), 0.9);
    assert.equal(q.tierFor("anthropic", "claude-x", "coding"), 0.97);
    assert.equal(q.tierFor("other", "unknown"), 0.4);
  });
  it("rejects out-of-range tiers", () => {
    assert.throws(() => new QualityTable([{ pattern: "x", tier: 1.5 }]));
  });
});

describe("scoreCandidates", () => {
  it("premium-first ranks the higher quality tier first when all else is equal", () => {
    const rows = scoreCandidates({
      req: req(),
      estInputTokens: 10,
      candidates: [cand("low"), cand("top"), cand("mid")],
      quality,
      weights: PROFILES.premiumFirst,
    });
    assert.deepEqual(rows.map((r) => r.model), ["top", "mid", "low"]);
  });

  it("cost-saver profile can prefer a cheaper, lower-tier model", () => {
    const priced = (id: string, price: number) => cand(id, { record: { inputPricePerM: price, outputPricePerM: price } });
    const mk = (w: WeightProfile) =>
      scoreCandidates({ req: req(), estInputTokens: 1000, candidates: [priced("top", 30), priced("low", 0.5)], quality, weights: w })[0]!.model;
    assert.equal(mk(PROFILES.premiumFirst), "top");
    assert.equal(mk(PROFILES.costSaver), "low");
  });

  it("filters models that are merely discovered/configured (catalogue != access)", () => {
    const rows = scoreCandidates({
      req: req(),
      estInputTokens: 1,
      candidates: [cand("top", { record: { state: "discovered" } }), cand("mid", { record: { state: "configured" } }), cand("low")],
      quality,
      weights: PROFILES.premiumFirst,
    });
    assert.equal(rows[0]!.model, "low");
    assert.equal(rows.filter((r) => r.eligible).length, 1);
    assert.match(rows.find((r) => r.model === "top")!.reasons.join(), /needs a successful probe/);
  });

  it("a pinned model bypasses only the access-state filter", () => {
    const rows = scoreCandidates({
      req: req({ requires: ["tools"] }),
      estInputTokens: 1,
      candidates: [cand("top", { pinned: true, record: { state: "configured", capabilities: ["tools"] } })],
      quality,
      weights: PROFILES.premiumFirst,
    });
    assert.equal(rows[0]!.eligible, true);
    const rows2 = scoreCandidates({
      req: req({ requires: ["tools"] }),
      estInputTokens: 1,
      candidates: [cand("top", { pinned: true, record: { state: "configured" } })],
      quality,
      weights: PROFILES.premiumFirst,
    });
    assert.equal(rows2[0]!.eligible, false); // still missing the capability
  });

  it("unknown prices are flagged, not treated as fact", () => {
    const rows = scoreCandidates({ req: req(), estInputTokens: 1, candidates: [cand("top")], quality, weights: PROFILES.balanced });
    assert.equal(rows[0]!.components?.costKnown, false);
    assert.equal(rows[0]!.components?.estCostUsd, undefined);
  });

  it("unseen models start at reliability 0.5, and failures lower it", () => {
    const rows = scoreCandidates({
      req: req(),
      estInputTokens: 1,
      candidates: [cand("a"), cand("b", { stats: { successes: 0, attempts: 8 } }), cand("c", { stats: { successes: 8, attempts: 8 } })],
      quality: new QualityTable(),
      weights: PROFILES.balanced,
    });
    const rel = Object.fromEntries(rows.map((r) => [r.model, r.components!.reliability]));
    assert.equal(rel["a"], 0.5);
    assert.ok(rel["b"]! < 0.5 && rel["c"]! > 0.5);
  });
});

// ---- seeded property test: hard constraints can never be outscored -------------------------

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

describe("scoreCandidates properties (seeded, 400 random scenarios)", () => {
  it("never ranks or marks eligible a candidate that violates a hard constraint", () => {
    const rnd = lcg(20261030);
    const states: ModelState[] = ["discovered", "configured", "accessible", "tested", "unavailable"];
    const caps: Capability[] = ["tools", "vision", "reasoning", "json"];
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;

    for (let n = 0; n < 400; n++) {
      const count = 1 + Math.floor(rnd() * 8);
      const candidates: Candidate[] = [];
      for (let i = 0; i < count; i++) {
        const capabilities = caps.filter(() => rnd() < 0.5);
        candidates.push(
          cand(`m${i}`, {
            record: {
              state: pick(states),
              capabilities,
              ...(rnd() < 0.7 ? { contextWindow: 1000 + Math.floor(rnd() * 100000) } : {}),
              ...(rnd() < 0.6 ? { inputPricePerM: rnd() * 20, outputPricePerM: rnd() * 60 } : {}),
            },
            breaker: pick(["closed", "open", "half_open"] as const),
            budget: rnd() < 0.3 ? { ok: false, reason: "cap" } : { ok: true },
            stats: { successes: Math.floor(rnd() * 20), attempts: 20, ...(rnd() < 0.5 ? { latencyEwmaMs: rnd() * 3000 } : {}) },
            priority: rnd(),
          }),
        );
      }
      const requires = caps.filter(() => rnd() < 0.25);
      const maxTokens = rnd() < 0.5 ? Math.floor(rnd() * 4000) : undefined;
      const estIn = Math.floor(rnd() * 50000);
      const request = req({ requires, ...(maxTokens !== undefined ? { maxTokens } : {}) });
      const w = pick([PROFILES.premiumFirst, PROFILES.balanced, PROFILES.costSaver]);
      const rows = scoreCandidates({ req: request, estInputTokens: estIn, candidates, quality, weights: w });

      assert.equal(rows.length, candidates.length);
      let seenIneligible = false;
      let prev = Infinity;
      for (const row of rows) {
        const c = candidates.find((x) => `${x.record.provider}/${x.record.modelId}` === row.key)!;
        assert.equal(row.eligible, row.reasons.length === 0);
        if (!row.eligible) {
          seenIneligible = true;
          assert.equal(row.score, undefined);
          continue;
        }
        assert.equal(seenIneligible, false, "ineligible row ranked above an eligible one");
        assert.ok(c.record.state === "accessible" || c.record.state === "tested");
        assert.ok(requires.every((r) => c.record.capabilities.includes(r)));
        if (c.record.contextWindow !== undefined) assert.ok(c.record.contextWindow >= estIn + (maxTokens ?? 0));
        assert.notEqual(c.breaker, "open");
        assert.equal(c.budget.ok, true);
        assert.ok(row.score! <= prev + 1e-12, "eligible rows must be sorted by descending score");
        prev = row.score!;
      }
    }
  });
});
