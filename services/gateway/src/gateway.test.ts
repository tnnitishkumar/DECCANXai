import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { buildApp, parseConfig, ConfigError, type App } from "./config.ts";
import { createGateway, parseChatBody } from "./server.ts";
import { startMockProvider, type MockProvider } from "../../../tests/support/mock-provider.ts";

const USER = "user-key-abc123";
const ADMIN = "admin-key-xyz789";
const UPSTREAM_KEY = "sk-upstream-SECRET-0123456789";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});

interface Env {
  base: string;
  app: App;
  mock: MockProvider;
  logs: Record<string, unknown>[];
}

async function setup(opts: { reply?: string; apiKey?: string; rate?: number } = {}): Promise<Env> {
  const mock = await startMockProvider({
    models: ["premium"],
    reply: opts.reply ?? "gateway says hi",
    apiKey: UPSTREAM_KEY,
  });
  const config = parseConfig({
    providers: [{ id: "up", baseUrl: mock.url, apiKeyEnv: "UP_KEY", models: { premium: { contextWindow: 100000, inputPricePerM: 2, outputPricePerM: 8 } } }],
    qualityRules: [{ pattern: "up/premium", tier: 0.9 }],
    ...(opts.rate ? { rateLimitPerMinute: opts.rate } : {}),
  });
  const app = buildApp(config, { UP_KEY: UPSTREAM_KEY, GATEWAY_API_KEYS: USER, GATEWAY_ADMIN_KEYS: ADMIN });
  const logs: Record<string, unknown>[] = [];
  const server: http.Server = createGateway({ app, log: (e) => logs.push(e) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
    () => mock.close(),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, app, mock, logs };
}

const call = (env: Env, path: string, init: RequestInit & { key?: string | null } = {}) => {
  const { key = USER, ...rest } = init;
  return fetch(`${env.base}${path}`, {
    ...rest,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(rest.headers ?? {}) },
  });
};

const chatBody = (o: Record<string, unknown> = {}) => JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], ...o });

/** Make the premium model accessible via the real admin endpoints (discover + probe). */
async function warm(env: Env) {
  assert.equal((await call(env, "/v1/admin/discover", { method: "POST", key: ADMIN, body: "{}" })).status, 200);
  const p = await call(env, "/v1/admin/probe", { method: "POST", key: ADMIN, body: JSON.stringify({ models: ["up/premium"] }) });
  const j = (await p.json()) as { results: Array<{ outcome: string }> };
  assert.equal(j.results[0]!.outcome, "accessible");
}

describe("config validation", () => {
  it("rejects secrets stored in the config file", () => {
    assert.throws(() => parseConfig({ providers: [{ id: "x", baseUrl: "https://a.example/v1", apiKey: "sk-nope" }] }), /secrets must not be stored/);
    assert.throws(() => parseConfig({ providers: [{ id: "x", baseUrl: "https://a.example/v1", headers: { Authorization: "Bearer z" } }] }), ConfigError);
  });
  it("rejects bad ids, duplicates, bad urls and keys over plain http to remote hosts", () => {
    assert.throws(() => parseConfig({ providers: [{ id: "a/b", baseUrl: "https://a.example/v1" }] }), /must match/);
    assert.throws(() => parseConfig({ providers: [{ id: "a", baseUrl: "https://a.example/v1" }, { id: "a", baseUrl: "https://b.example/v1" }] }), /duplicated/);
    assert.throws(() => parseConfig({ providers: [{ id: "a", baseUrl: "not a url" }] }), /valid URL/);
    assert.throws(() => parseConfig({ providers: [{ id: "a", baseUrl: "http://remote.example/v1", apiKeyEnv: "K" }] }), /plain http/);
    assert.doesNotThrow(() => parseConfig({ providers: [{ id: "a", baseUrl: "http://localhost:11434/v1" }] }));
  });
  it("fails to build when a referenced key variable is unset", () => {
    const c = parseConfig({ providers: [{ id: "a", baseUrl: "https://a.example/v1", apiKeyEnv: "MISSING_KEY" }] });
    assert.throws(() => buildApp(c, {}), /MISSING_KEY is not set/);
  });
  it("validates budgets, tiers and profiles", () => {
    const p = [{ id: "a", baseUrl: "https://a.example/v1" }];
    assert.throws(() => parseConfig({ providers: p, weightProfile: "yolo" }), /weightProfile/);
    assert.throws(() => parseConfig({ providers: p, qualityRules: [{ pattern: "x", tier: 2 }] }), /qualityRules/);
    assert.throws(() => parseConfig({ providers: p, budgets: [{ id: "b", window: "week" }] }), /budgets/);
  });
});

describe("parseChatBody", () => {
  it("rejects unsupported features loudly instead of ignoring them", () => {
    const m = [{ role: "user", content: "x" }];
    assert.throws(() => parseChatBody({ messages: m, tools: [] }), /'tools' is not supported/);
    assert.throws(() => parseChatBody({ messages: m, response_format: { type: "json_object" } }), /not supported/);
    assert.throws(() => parseChatBody({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }), /not yet supported/);
    assert.throws(() => parseChatBody({ messages: [] }), /non-empty/);
    assert.throws(() => parseChatBody({ messages: m, temperature: 5 }), /temperature/);
  });
  it("accepts text parts, defaults model to auto, and reads routing hints", () => {
    const r = parseChatBody({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }], deccanxai: { requires: ["tools"], task_class: "coding" } });
    assert.equal(r.model, "auto");
    assert.equal(r.messages[0]!.content, "a\nb");
    assert.deepEqual(r.requires, ["tools"]);
    assert.equal(r.taskClass, "coding");
  });
});

describe("gateway HTTP", () => {
  it("healthz is open; everything else requires auth", async () => {
    const env = await setup();
    assert.equal((await call(env, "/healthz", { key: null })).status, 200);
    const r = await call(env, "/v1/models", { key: null });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
    assert.equal((await call(env, "/v1/models", { key: "wrong" })).status, 401);
  });

  it("admin endpoints reject user keys and accept admin keys", async () => {
    const env = await setup();
    for (const p of ["/v1/usage/summary", "/v1/usage/history", "/v1/router/decisions", "/v1/registry/counts"]) {
      assert.equal((await call(env, p)).status, 403, p);
      assert.equal((await call(env, p, { key: ADMIN })).status, 200, p);
    }
    assert.equal((await call(env, "/v1/admin/discover", { method: "POST", body: "{}" })).status, 403);
  });

  it("a freshly discovered model is listed but flagged unverified, and cannot serve auto traffic", async () => {
    const env = await setup();
    await call(env, "/v1/admin/discover", { method: "POST", key: ADMIN, body: "{}" });
    const models = (await (await call(env, "/v1/models")).json()) as { data: Array<{ id: string; x_deccanxai: { state: string; note?: string } }> };
    assert.equal(models.data[0]!.id, "up/premium");
    assert.equal(models.data[0]!.x_deccanxai.state, "configured");
    assert.match(models.data[0]!.x_deccanxai.note ?? "", /not been verified/);
    const r = await call(env, "/v1/chat/completions", { method: "POST", body: chatBody() });
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, "no_eligible_model");
  });

  it("serves a non-streaming completion with measured usage, and the upstream key never reaches the client", async () => {
    const env = await setup({ reply: "gateway says hi" });
    await warm(env);
    const r = await call(env, "/v1/chat/completions", { method: "POST", body: chatBody() });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!text.includes(UPSTREAM_KEY));
    const j = JSON.parse(text);
    assert.equal(j.object, "chat.completion");
    assert.equal(j.model, "up/premium");
    assert.equal(j.choices[0].message.content, "gateway says hi");
    assert.deepEqual(j.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.equal(j.x_deccanxai.usage_provenance, "measured");
    assert.ok(r.headers.get("x-request-id"));
    assert.ok(env.mock.calls.every((c) => c.hadAuth), "gateway authenticated upstream with its own key");
  });

  it("streams SSE in OpenAI chunk format, ending with usage and [DONE]", async () => {
    const env = await setup({ reply: "one two three" });
    await warm(env);
    const r = await call(env, "/v1/chat/completions", { method: "POST", body: chatBody({ stream: true }) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await r.text();
    const events = body.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""));
    assert.equal(events.at(-1), "[DONE]");
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    assert.equal(parsed[0].choices[0].delta.role, "assistant");
    assert.equal(parsed.map((p) => p.choices[0]?.delta?.content ?? "").join(""), "one two three");
    const last = parsed.at(-1);
    assert.equal(last.choices[0].finish_reason, "stop");
    assert.equal(last.usage.total_tokens, 18);
  });

  it("records every served request in the ledger exposed by the admin API", async () => {
    const env = await setup();
    await warm(env);
    await call(env, "/v1/chat/completions", { method: "POST", body: chatBody() });
    const s = (await (await call(env, "/v1/usage/summary", { key: ADMIN })).json()) as {
      total: { requests: number; tokens: { input: { measured: number } }; estimatedCostUsd: number };
    };
    assert.equal(s.total.requests, 1);
    assert.equal(s.total.tokens.input.measured, 11);
    assert.equal(s.total.estimatedCostUsd, (11 * 2 + 7 * 8) / 1_000_000);
  });

  it("validation errors are 400 with an OpenAI-style error body", async () => {
    const env = await setup();
    const r = await call(env, "/v1/chat/completions", { method: "POST", body: chatBody({ tools: [{}] }) });
    assert.equal(r.status, 400);
    const j = (await r.json()) as { error: { type: string; message: string; request_id: string } };
    assert.equal(j.error.type, "invalid_request_error");
    assert.ok(j.error.request_id);
    assert.equal((await call(env, "/v1/chat/completions", { method: "POST", body: "{not json" })).status, 400);
  });

  it("rejects oversized bodies with 413 and unknown routes with 404", async () => {
    const env = await setup();
    const big = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(1_100_000) }] });
    assert.equal((await call(env, "/v1/chat/completions", { method: "POST", body: big })).status, 413);
    assert.equal((await call(env, "/v1/nope")).status, 404);
    assert.equal((await call(env, "/v1/chat/completions")).status, 405);
  });

  it("rate-limits per key with Retry-After", async () => {
    const env = await setup({ rate: 3 });
    for (let i = 0; i < 3; i++) assert.equal((await call(env, "/v1/models")).status, 200);
    const r = await call(env, "/v1/models");
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) >= 1);
    assert.equal((await call(env, "/v1/models", { key: ADMIN })).status, 200); // other principal unaffected
  });

  it("maps an exhausted budget to 429 insufficient_quota", async () => {
    const env = await setup();
    await warm(env);
    env.app.ledger.setBudgets([{ id: "cap", scope: {}, window: "day", maxRequests: 1 }]);
    assert.equal((await call(env, "/v1/chat/completions", { method: "POST", body: chatBody() })).status, 200);
    const r = await call(env, "/v1/chat/completions", { method: "POST", body: chatBody() });
    assert.equal(r.status, 429);
    assert.equal(((await r.json()) as { error: { type: string } }).error.type, "insufficient_quota");
  });

  it("access logs carry no prompts, completions or credentials", async () => {
    const env = await setup({ reply: "TOPSECRETREPLY" });
    await warm(env);
    await call(env, "/v1/chat/completions", { method: "POST", body: chatBody({ messages: [{ role: "user", content: "TOPSECRETPROMPT" }] }) });
    const dump = JSON.stringify(env.logs);
    for (const s of ["TOPSECRETPROMPT", "TOPSECRETREPLY", USER, ADMIN, UPSTREAM_KEY]) assert.ok(!dump.includes(s), `log leaked ${s}`);
    assert.ok(env.logs.some((l) => l["path"] === "/v1/chat/completions" && l["status"] === 200));
  });

  it("probe requires explicit models and cannot reach unknown providers", async () => {
    const env = await setup();
    assert.equal((await call(env, "/v1/admin/probe", { method: "POST", key: ADMIN, body: "{}" })).status, 400);
    const r = await call(env, "/v1/admin/probe", { method: "POST", key: ADMIN, body: JSON.stringify({ models: ["ghost/m"] }) });
    const j = (await r.json()) as { results: Array<{ outcome: string }> };
    assert.equal(j.results[0]!.outcome, "error");
  });
});
