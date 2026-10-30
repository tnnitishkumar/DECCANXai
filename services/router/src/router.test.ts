import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeccanError } from "#shared";
import type { ChatRequest, StreamChunk } from "#shared";
import { OpenAICompatibleAdapter } from "#adapters";
import { ModelRegistry } from "#registry";
import { UsageLedger } from "#usage";
import { Router, type RouterOptions } from "./router.ts";
import { QualityTable } from "./quality.ts";
import { CircuitBreaker } from "./breaker.ts";
import { startMockProvider, type MockProvider, type MockProviderOptions } from "../../../tests/support/mock-provider.ts";

const quality = new QualityTable([
  { pattern: "p-a/premium", tier: 0.9 },
  { pattern: "p-b/basic", tier: 0.4 },
]);

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "auto",
  messages: [{ role: "user", content: "hello" }],
  ...o,
});

const mocks: MockProvider[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const chatCalls = (m: MockProvider) => m.calls.filter((c) => c.path.endsWith("/chat/completions")).length;

interface World {
  a: MockProvider;
  b: MockProvider;
  registry: ModelRegistry;
  ledger: UsageLedger;
  sleeps: number[];
  router: Router;
}

/** Two real HTTP providers; both models are made 'accessible' by real probes BEFORE any fault is injected. */
async function world(
  optsA: MockProviderOptions = {},
  optsB: MockProviderOptions = {},
  routerOpts: Partial<RouterOptions> = {},
): Promise<World> {
  const a = await startMockProvider({ models: ["premium"], reply: "from A", ...optsA });
  const b = await startMockProvider({ models: ["basic"], reply: "from B", ...optsB });
  mocks.push(a, b);
  const adA = new OpenAICompatibleAdapter({ id: "p-a", baseUrl: a.url });
  const adB = new OpenAICompatibleAdapter({ id: "p-b", baseUrl: b.url });
  const registry = new ModelRegistry();
  await registry.discover(adA);
  await registry.discover(adB);
  registry.markProviderConfigured("p-a");
  registry.markProviderConfigured("p-b");
  await registry.probe(adA, "premium");
  await registry.probe(adB, "basic");
  const ledger = new UsageLedger();
  const sleeps: number[] = [];
  const router = new Router({
    adapters: [adA, adB],
    registry,
    ledger,
    quality,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1, // jitter factor exactly 1.0 -> deterministic delays
    ...routerOpts,
  });
  return { a, b, registry, ledger, sleeps, router };
}

async function collect(it: AsyncGenerator<StreamChunk>) {
  const chunks: StreamChunk[] = [];
  for await (const c of it) chunks.push(c);
  return chunks;
}

describe("Router.chat: selection", () => {
  it("premium-first picks the higher-tier accessible model and records a score table", async () => {
    const w = await world();
    const { response, decision } = await w.router.chat(req());
    assert.equal(response.provider, "p-a");
    assert.equal(response.content, "from A");
    assert.deepEqual(decision.chosen, { provider: "p-a", model: "premium" });
    assert.equal(decision.table.length, 2);
    assert.ok(decision.table[0]!.score! > decision.table[1]!.score!);
    assert.equal(w.router.recentDecisions(1)[0]!.requestId, decision.requestId);
  });

  it("never routes to a premium model that is only discovered (not probed)", async () => {
    const a = await startMockProvider({ models: ["premium"] });
    const b = await startMockProvider({ models: ["basic"], reply: "from B" });
    mocks.push(a, b);
    const adA = new OpenAICompatibleAdapter({ id: "p-a", baseUrl: a.url });
    const adB = new OpenAICompatibleAdapter({ id: "p-b", baseUrl: b.url });
    const registry = new ModelRegistry();
    await registry.discover(adA); // listed only
    await registry.discover(adB);
    await registry.probe(adB, "basic");
    const router = new Router({ adapters: [adA, adB], registry, ledger: new UsageLedger(), quality });
    const { response, decision } = await router.chat(req());
    assert.equal(response.provider, "p-b");
    assert.equal(chatCalls(a), 0);
    assert.match(decision.table.find((r) => r.provider === "p-a")!.reasons.join(), /discovered/);
  });

  it("reports no_candidates with reasons when nothing is accessible", async () => {
    const a = await startMockProvider({ models: ["premium"] });
    mocks.push(a);
    const adA = new OpenAICompatibleAdapter({ id: "p-a", baseUrl: a.url });
    const registry = new ModelRegistry();
    await registry.discover(adA);
    const router = new Router({ adapters: [adA], registry, ledger: new UsageLedger() });
    await assert.rejects(
      () => router.chat(req()),
      (e: unknown) => e instanceof DeccanError && e.kind === "no_candidates" && /probe/.test(e.message),
    );
  });

  it("filters on required capabilities (hard constraint)", async () => {
    const w = await world();
    await assert.rejects(
      () => w.router.chat(req({ requires: ["tools"] })),
      (e: unknown) => e instanceof DeccanError && e.kind === "no_candidates" && /missing capability 'tools'/.test(e.message),
    );
    w.registry.setMetadata("p-b", "basic", { capabilities: ["tools"] });
    const { response } = await w.router.chat(req({ requires: ["tools"] }));
    assert.equal(response.provider, "p-b");
  });

  it("honours pinned models, including ones the catalogue never listed", async () => {
    const w = await world();
    const pinned = await w.router.chat(req({ model: "p-b/basic" }));
    assert.equal(pinned.response.provider, "p-b");
    const unlisted = await w.router.chat(req({ model: "p-a/some-new-model" }));
    assert.equal(unlisted.response.provider, "p-a");
    assert.equal(w.registry.get("p-a", "some-new-model")?.state, "tested"); // recorded honestly after serving
    await assert.rejects(
      () => w.router.chat(req({ model: "nope/none" })),
      (e: unknown) => e instanceof DeccanError && e.kind === "bad_request",
    );
  });
});

describe("Router.chat: retries, backoff and failover", () => {
  it("retries the same model with exponential backoff, then succeeds", async () => {
    const w = await world({}, {}, { retry: { maxAttemptsPerCandidate: 3, baseDelayMs: 200, maxDelayMs: 5000 } });
    w.a.setFailures([503, 503]);
    const { response, decision } = await w.router.chat(req());
    assert.equal(response.provider, "p-a");
    assert.deepEqual(w.sleeps, [200, 400]);
    assert.deepEqual(decision.attempts.map((x) => x.outcome), ["error", "error", "ok"]);
  });

  it("honours Retry-After when it is within the cap", async () => {
    const w = await world({ retryAfterSec: 1 }, {}, { retry: { maxAttemptsPerCandidate: 2 } });
    w.a.setFailures([429]);
    const { response } = await w.router.chat(req());
    assert.equal(response.provider, "p-a");
    assert.deepEqual(w.sleeps, [1000]);
  });

  it("fails over immediately (no stalling) when Retry-After exceeds the cap", async () => {
    const w = await world({ retryAfterSec: 60 }, {}, { retry: { maxAttemptsPerCandidate: 3, maxDelayMs: 5000 } });
    w.a.setFailures([429]);
    const { response, decision } = await w.router.chat(req());
    assert.equal(response.provider, "p-b");
    assert.deepEqual(w.sleeps, []);
    assert.deepEqual(decision.attempts.map((x) => `${x.provider}:${x.outcome}`), ["p-a:error", "p-b:ok"]);
  });

  it("fails over to the next candidate after exhausting attempts and logs every attempt", async () => {
    const w = await world({}, {}, { retry: { maxAttemptsPerCandidate: 2, baseDelayMs: 200 } });
    w.a.setAlwaysFail(503);
    const before = chatCalls(w.a);
    const { response, decision } = await w.router.chat(req());
    assert.equal(response.provider, "p-b");
    assert.equal(chatCalls(w.a) - before, 2);
    assert.deepEqual(w.sleeps, [200]);
    assert.deepEqual(decision.attempts.map((x) => `${x.provider}:${x.outcome}`), ["p-a:error", "p-a:error", "p-b:ok"]);
    const hist = w.ledger.history(10).reverse();
    assert.deepEqual(hist.map((e) => `${e.provider}:${e.status}`), ["p-a:error", "p-a:error", "p-b:ok"]);
  });

  it("surfaces the last error when every candidate fails", async () => {
    const w = await world({ alwaysFail: undefined }, {}, { retry: { maxAttemptsPerCandidate: 1 } });
    w.a.setAlwaysFail(503);
    w.b.setAlwaysFail(500);
    await assert.rejects(
      () => w.router.chat(req()),
      (e: unknown) => e instanceof DeccanError && e.kind === "unavailable",
    );
  });

  it("treats bad_request as terminal: no failover to other models", async () => {
    const w = await world();
    w.a.setAlwaysFail(400);
    const bBefore = chatCalls(w.b);
    await assert.rejects(
      () => w.router.chat(req()),
      (e: unknown) => e instanceof DeccanError && e.kind === "bad_request",
    );
    assert.equal(chatCalls(w.b), bBefore);
  });

  it("on an auth failure fails over and marks the model unavailable", async () => {
    const w = await world();
    w.a.setAlwaysFail(401);
    const { response } = await w.router.chat(req());
    assert.equal(response.provider, "p-b");
    assert.equal(w.registry.get("p-a", "premium")?.state, "unavailable");
    // and it is excluded from subsequent routing without another call
    const before = chatCalls(w.a);
    await w.router.chat(req());
    assert.equal(chatCalls(w.a), before);
  });
});

describe("Router: circuit breaker integration", () => {
  it("stops sending traffic to a failing model once its breaker opens", async () => {
    let t = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, now: () => t });
    const w = await world({}, {}, { breaker, retry: { maxAttemptsPerCandidate: 1 }, now: () => t });
    w.a.setAlwaysFail(503);
    const base = chatCalls(w.a);
    await w.router.chat(req()); // failure 1 on A -> served by B
    await w.router.chat(req()); // failure 2 on A -> breaker opens
    assert.equal(chatCalls(w.a) - base, 2);
    const third = await w.router.chat(req());
    assert.equal(third.response.provider, "p-b");
    assert.equal(chatCalls(w.a) - base, 2, "no traffic while the breaker is open");
    assert.match(third.decision.table.find((r) => r.provider === "p-a")!.reasons.join(), /circuit breaker open/);

    // After cooldown a single trial goes through; recovery closes the breaker.
    w.a.setAlwaysFail(undefined);
    t = 10_000;
    const trial = await w.router.chat(req());
    assert.equal(trial.response.provider, "p-a");
    assert.equal(breaker.state("p-a/premium"), "closed");
  });
});

describe("Router: budgets and accounting", () => {
  it("routes around a provider whose budget is exhausted, and errors when all are", async () => {
    const w = await world();
    w.ledger.setBudgets([{ id: "a-cap", scope: { provider: "p-a" }, window: "day", maxRequests: 1 }]);
    const r1 = await w.router.chat(req());
    assert.equal(r1.response.provider, "p-a");
    const r2 = await w.router.chat(req());
    assert.equal(r2.response.provider, "p-b");
    assert.match(r2.decision.table.find((r) => r.provider === "p-a")!.reasons.join(), /budget/);

    w.ledger.setBudgets([{ id: "global", scope: {}, window: "day", maxRequests: 2 }]);
    await assert.rejects(
      () => w.router.chat(req()),
      (e: unknown) => e instanceof DeccanError && e.kind === "budget_exceeded",
    );
  });

  it("records measured usage, and computes cost only when a price is known", async () => {
    const w = await world();
    w.registry.setMetadata("p-a", "premium", { inputPricePerM: 3, outputPricePerM: 15 });
    await w.router.chat(req()); // A: priced
    await w.router.chat(req({ model: "p-b/basic" })); // B: unpriced
    const hist = w.ledger.history(2).reverse();
    assert.equal(hist[0]!.tokenProvenance, "measured");
    assert.equal(hist[0]!.inputTokens, 11);
    assert.equal(hist[0]!.costUsd, (11 * 3 + 7 * 15) / 1_000_000);
    assert.equal(hist[1]!.costUsd, undefined);
    const s = w.ledger.summary().total;
    assert.equal(s.unpricedRequests, 1);
  });

  it("tags usage as estimated when the provider does not report it", async () => {
    const w = await world({ reportUsage: false });
    await w.router.chat(req());
    assert.equal(w.ledger.history(1)[0]!.tokenProvenance, "estimated");
    assert.deepEqual(w.ledger.summary().total.tokens.input.measured, 0);
  });

  it("promotes the model to 'tested' after serving a real request", async () => {
    const w = await world();
    assert.equal(w.registry.get("p-a", "premium")?.state, "accessible");
    await w.router.chat(req());
    assert.equal(w.registry.get("p-a", "premium")?.state, "tested");
  });
});

describe("Router.stream", () => {
  it("streams from the best model and records measured usage at the end", async () => {
    const w = await world({ reply: "alpha beta gamma" });
    const { decision, chunks } = w.router.stream(req({ stream: true }));
    const out = await collect(chunks);
    assert.equal(out.map((c) => c.delta).join(""), "alpha beta gamma");
    assert.deepEqual(decision.chosen, { provider: "p-a", model: "premium" });
    const e = w.ledger.history(1)[0]!;
    assert.equal(e.status, "ok");
    assert.equal(e.tokenProvenance, "measured");
  });

  it("fails over before the first chunk is delivered", async () => {
    const w = await world({}, { reply: "rescued by B" }, { retry: { maxAttemptsPerCandidate: 1 } });
    w.a.setAlwaysFail(503);
    const { decision, chunks } = w.router.stream(req({ stream: true }));
    const out = await collect(chunks);
    assert.equal(out.map((c) => c.delta).join(""), "rescued by B");
    assert.deepEqual(decision.attempts.map((x) => `${x.provider}:${x.outcome}`), ["p-a:error", "p-b:ok"]);
  });

  it("does NOT silently restart after data was delivered: records the failure and surfaces it", async () => {
    const w = await world({ reply: "a b c d e f", breakStreamAfter: 2 });
    const bBefore = chatCalls(w.b);
    const { chunks } = w.router.stream(req({ stream: true }));
    const received: string[] = [];
    await assert.rejects(
      async () => {
        for await (const c of chunks) received.push(c.delta);
      },
      (e: unknown) => e instanceof DeccanError && e.retryable,
    );
    assert.ok(received.length >= 1, "caller received partial data before the failure");
    assert.equal(chatCalls(w.b), bBefore, "no hidden retry on another model");
    assert.equal(w.ledger.history(1)[0]!.status, "error");
  });

  it("estimates (and labels) usage when a stream provider reports none", async () => {
    const w = await world({ reply: "no usage reported", reportUsage: false });
    const { chunks } = w.router.stream(req({ stream: true }));
    await collect(chunks);
    assert.equal(w.ledger.history(1)[0]!.tokenProvenance, "estimated");
  });
});
