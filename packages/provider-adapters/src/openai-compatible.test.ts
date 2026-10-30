import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleAdapter, estimateTokens } from "./openai-compatible.ts";
import { DeccanError } from "#shared";
import type { ChatRequest } from "#shared";
import { startMockProvider, type MockProvider } from "../../../tests/support/mock-provider.ts";

const req: ChatRequest = { model: "m", messages: [{ role: "user", content: "hello there" }] };
let mock: MockProvider | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("OpenAICompatibleAdapter", () => {
  it("discovers models as 'discovered', never 'accessible'", async () => {
    mock = await startMockProvider({ models: ["a", "b"] });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    const models = await a.listModels();
    assert.deepEqual(models.map((m) => m.modelId), ["a", "b"]);
    assert.ok(models.every((m) => m.state === "discovered"));
    assert.ok(models.every((m) => m.inputPricePerM === undefined)); // pricing never guessed
  });

  it("chat returns measured usage when the provider reports it", async () => {
    mock = await startMockProvider({ reply: "hi", promptTokens: 21, completionTokens: 5 });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    const r = await a.chat(req, "mock-model");
    assert.equal(r.content, "hi");
    assert.equal(r.provider, "mock");
    assert.deepEqual(r.usage, { inputTokens: 21, outputTokens: 5, provenance: "measured" });
  });

  it("chat tags usage as estimated when the provider omits it", async () => {
    mock = await startMockProvider({ reply: "twelve chars", reportUsage: false });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    const r = await a.chat(req, "mock-model");
    assert.equal(r.usage.provenance, "estimated");
    assert.equal(r.usage.outputTokens, estimateTokens("twelve chars"));
  });

  it("streams deltas in order and ends with measured usage", async () => {
    mock = await startMockProvider({ reply: "one two three", promptTokens: 9, completionTokens: 3 });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    let text = "";
    let last;
    for await (const c of a.stream(req, "mock-model")) {
      text += c.delta;
      last = c;
    }
    assert.equal(text, "one two three");
    assert.equal(last?.finishReason, "stop");
    assert.deepEqual(last?.usage, { inputTokens: 9, outputTokens: 3, provenance: "measured" });
  });

  it("sends the API key as a bearer token and 401s map to non-retryable auth errors", async () => {
    mock = await startMockProvider({ apiKey: "sk-test-secret-123456" });
    const bad = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url, apiKey: "sk-wrong-000000000" });
    await assert.rejects(
      () => bad.chat(req, "mock-model"),
      (e: unknown) => e instanceof DeccanError && e.kind === "auth" && !e.retryable,
    );
    const good = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url, apiKey: "sk-test-secret-123456" });
    const r = await good.chat(req, "mock-model");
    assert.equal(r.content.length > 0, true);
  });

  it("maps 429 with Retry-After and 503 to retryable errors", async () => {
    mock = await startMockProvider({ failures: [429, 503], retryAfterSec: 2 });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    await assert.rejects(
      () => a.chat(req, "mock-model"),
      (e: unknown) => e instanceof DeccanError && e.kind === "rate_limited" && e.retryAfterSec === 2,
    );
    await assert.rejects(
      () => a.chat(req, "mock-model"),
      (e: unknown) => e instanceof DeccanError && e.kind === "unavailable" && e.retryable,
    );
  });

  it("times out slow providers as retryable 'timeout'", async () => {
    mock = await startMockProvider({ delayMs: 400 });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url, timeoutMs: 50 });
    await assert.rejects(
      () => a.chat(req, "mock-model"),
      (e: unknown) => e instanceof DeccanError && e.kind === "timeout",
    );
  });

  it("surfaces a mid-stream disconnect as a retryable error", async () => {
    mock = await startMockProvider({ reply: "a b c d e f", breakStreamAfter: 2 });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    await assert.rejects(
      async () => {
        for await (const _ of a.stream(req, "mock-model")) {
          /* drain */
        }
      },
      (e: unknown) => e instanceof DeccanError && e.retryable,
    );
  });

  it("treats a cleanly-closed but unfinished stream as a failure, not a success", async () => {
    mock = await startMockProvider({ reply: "a b c d e f", truncateStreamAfter: 2 });
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    const seen: string[] = [];
    await assert.rejects(
      async () => {
        for await (const c of a.stream(req, "mock-model")) seen.push(c.delta);
      },
      (e: unknown) => e instanceof DeccanError && e.kind === "unavailable" && /truncated/.test(e.message),
    );
    assert.deepEqual(seen, ["a", " b"]); // partial data was delivered before the error
  });

  it("never leaks the API key into error messages", async () => {
    mock = await startMockProvider({ alwaysFail: 500 });
    const key = "sk-super-secret-key-987654321";
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url, apiKey: key });
    try {
      await a.chat(req, "mock-model");
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(!(e as Error).message.includes(key));
    }
  });

  it("healthCheck is true when reachable and false when down", async () => {
    mock = await startMockProvider();
    const a = new OpenAICompatibleAdapter({ id: "mock", baseUrl: mock.url });
    assert.equal(await a.healthCheck(), true);
    mock.setAlwaysFail(503);
    assert.equal(await a.healthCheck(), false);
  });
});
