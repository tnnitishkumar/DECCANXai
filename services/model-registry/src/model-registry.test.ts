import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry } from "./index.ts";
import { OpenAICompatibleAdapter } from "#adapters";
import { startMockProvider, type MockProvider } from "../../../tests/support/mock-provider.ts";

let mock: MockProvider | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("ModelRegistry lifecycle", () => {
  it("discovery yields 'discovered' only; configuring upgrades to 'configured'", async () => {
    mock = await startMockProvider({ models: ["a", "b"] });
    const reg = new ModelRegistry();
    const ad = new OpenAICompatibleAdapter({ id: "p", baseUrl: mock.url });
    assert.equal(await reg.discover(ad), 2);
    assert.deepEqual(reg.counts(), { discovered: 2, configured: 0, accessible: 0, tested: 0, unavailable: 0 });
    reg.markProviderConfigured("p");
    assert.equal(reg.counts().configured, 2);
    assert.equal(reg.counts().accessible, 0); // listing/configuring never implies access
  });

  it("a successful probe makes a model 'accessible' with a verification time", async () => {
    mock = await startMockProvider({ models: ["a"] });
    const reg = new ModelRegistry({ now: () => Date.UTC(2026, 9, 30, 12) });
    const ad = new OpenAICompatibleAdapter({ id: "p", baseUrl: mock.url });
    await reg.discover(ad);
    assert.deepEqual(await reg.probe(ad, "a"), { outcome: "accessible" });
    const m = reg.get("p", "a")!;
    assert.equal(m.state, "accessible");
    assert.equal(m.lastVerifiedAt, "2026-10-30T12:00:00.000Z");
    assert.equal(mock.calls.at(-1)?.body.max_tokens, 1); // probe is a minimal real call
  });

  it("an auth failure marks the model 'unavailable'", async () => {
    mock = await startMockProvider({ models: ["a"], apiKey: "sk-correct-key-123456" });
    const reg = new ModelRegistry();
    const ad = new OpenAICompatibleAdapter({ id: "p", baseUrl: mock.url, apiKey: "sk-wrong-key-123456" });
    reg.upsertDiscovered([{ provider: "p", modelId: "a", displayName: "a", capabilities: [], state: "discovered" }]);
    const r = await reg.probe(ad, "a");
    assert.equal(r.outcome, "unavailable");
    assert.equal(reg.get("p", "a")?.state, "unavailable");
  });

  it("a rate limit during probing is inconclusive and leaves state unchanged", async () => {
    mock = await startMockProvider({ models: ["a"], failures: [429] });
    const reg = new ModelRegistry();
    const ad = new OpenAICompatibleAdapter({ id: "p", baseUrl: mock.url });
    reg.upsertDiscovered([{ provider: "p", modelId: "a", displayName: "a", capabilities: [], state: "discovered" }]);
    const r = await reg.probe(ad, "a");
    assert.equal(r.outcome, "inconclusive");
    assert.equal(reg.get("p", "a")?.state, "discovered");
  });

  it("serving a request promotes to 'tested'; re-discovery never downgrades", async () => {
    mock = await startMockProvider({ models: ["a"] });
    const reg = new ModelRegistry();
    const ad = new OpenAICompatibleAdapter({ id: "p", baseUrl: mock.url });
    await reg.discover(ad);
    reg.markServed("p", "a");
    assert.equal(reg.get("p", "a")?.state, "tested");
    await reg.discover(ad);
    assert.equal(reg.get("p", "a")?.state, "tested");
    await reg.probe(ad, "a");
    assert.equal(reg.get("p", "a")?.state, "tested");
  });

  it("resolves provider/model, bare ids, and reports ambiguity", () => {
    const reg = new ModelRegistry();
    reg.upsertDiscovered([
      { provider: "p1", modelId: "x", displayName: "x", capabilities: [], state: "discovered" },
      { provider: "p2", modelId: "x", displayName: "x", capabilities: [], state: "discovered" },
      { provider: "p1", modelId: "y", displayName: "y", capabilities: [], state: "discovered" },
    ]);
    const known = ["p1", "p2"];
    assert.equal((reg.resolve("p2/x", known) as any).provider, "p2");
    assert.equal((reg.resolve("y", known) as any).provider, "p1");
    assert.ok("error" in reg.resolve("x", known));
    assert.ok("error" in reg.resolve("nope", known));
  });
});
