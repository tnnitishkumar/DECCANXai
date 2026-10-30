import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Capability, ChatRequest, ModelRecord, TaskClass } from "#shared";
import { DeccanError, redact } from "#shared";
import type { Principal } from "#security";
import type { App } from "./config.ts";

const ROLES = ["system", "user", "assistant", "tool"] as const;
const CAPS: Capability[] = ["tools", "vision", "reasoning", "json"];
const TASK_CLASSES: TaskClass[] = ["general", "coding", "reasoning", "chat"];

class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, type: string, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.headers = headers;
  }
}

const bad = (message: string) => new HttpError(400, "invalid_request_error", "invalid_request", message);

export interface GatewayOptions {
  app: App;
  version?: string;
  maxBodyBytes?: number;
  /** Structured log sink. Never receives prompts, completions, keys or tokens. */
  log?: (entry: Record<string, unknown>) => void;
}

function mapError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof DeccanError) {
    switch (e.kind) {
      case "bad_request":
        return new HttpError(400, "invalid_request_error", "upstream_rejected_request", e.message);
      case "budget_exceeded":
        return new HttpError(429, "insufficient_quota", "budget_exceeded", e.message);
      case "rate_limited":
        return new HttpError(429, "rate_limit_exceeded", "upstream_rate_limited", e.message, e.retryAfterSec !== undefined ? { "retry-after": String(Math.ceil(e.retryAfterSec)) } : {});
      case "auth":
        return new HttpError(502, "upstream_error", "upstream_auth_failed", e.message);
      case "timeout":
        return new HttpError(504, "upstream_error", "upstream_timeout", e.message);
      case "no_candidates":
        return new HttpError(503, "upstream_error", "no_eligible_model", e.message);
      case "unavailable":
        return new HttpError(503, "upstream_error", "upstream_unavailable", e.message);
      default:
        return new HttpError(500, "internal_error", "internal_error", "internal server error");
    }
  }
  return new HttpError(500, "internal_error", "internal_error", "internal server error");
}

async function readJson(req: http.IncomingMessage, max: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "invalid_request_error", "body_too_large", `request body exceeds ${max} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, "invalid_request_error", "body_too_large", `request body exceeds ${max} bytes`);
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw bad("request body is not valid JSON");
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string") {
        parts.push((p as { text: string }).text);
      } else {
        throw bad("only text content parts are supported in this version (images/audio are not yet supported)");
      }
    }
    return parts.join("\n");
  }
  throw bad("message content must be a string or an array of text parts");
}

export function parseChatBody(b: unknown): ChatRequest {
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw bad("body must be a JSON object");
  const o = b as Record<string, unknown>;
  // Honest scope: unsupported features are rejected, never silently ignored.
  for (const f of ["tools", "tool_choice", "functions", "function_call", "response_format", "n"]) {
    if (o[f] !== undefined && !(f === "n" && o[f] === 1)) throw bad(`'${f}' is not supported by this gateway version`);
  }
  const model = o["model"] === undefined ? "auto" : o["model"];
  if (typeof model !== "string") throw bad("'model' must be a string");
  const msgs = o["messages"];
  if (!Array.isArray(msgs) || msgs.length === 0) throw bad("'messages' must be a non-empty array");
  const messages = msgs.map((m, i) => {
    if (typeof m !== "object" || m === null) throw bad(`messages[${i}] must be an object`);
    const mm = m as Record<string, unknown>;
    if (!ROLES.includes(mm["role"] as (typeof ROLES)[number])) throw bad(`messages[${i}].role must be one of ${ROLES.join(", ")}`);
    return {
      role: mm["role"] as (typeof ROLES)[number],
      content: contentToText(mm["content"]),
      ...(typeof mm["name"] === "string" ? { name: mm["name"] } : {}),
      ...(typeof mm["tool_call_id"] === "string" ? { toolCallId: mm["tool_call_id"] } : {}),
    };
  });
  const req: ChatRequest = { model, messages };
  if (o["stream"] !== undefined) {
    if (typeof o["stream"] !== "boolean") throw bad("'stream' must be a boolean");
    req.stream = o["stream"];
  }
  if (o["temperature"] !== undefined) {
    if (typeof o["temperature"] !== "number" || o["temperature"] < 0 || o["temperature"] > 2) throw bad("'temperature' must be a number between 0 and 2");
    req.temperature = o["temperature"];
  }
  const mt = o["max_tokens"] ?? o["max_completion_tokens"];
  if (mt !== undefined) {
    if (typeof mt !== "number" || !Number.isInteger(mt) || mt < 1) throw bad("'max_tokens' must be a positive integer");
    req.maxTokens = mt;
  }
  const ext = o["deccanxai"];
  if (ext !== undefined) {
    if (typeof ext !== "object" || ext === null || Array.isArray(ext)) throw bad("'deccanxai' must be an object");
    const e = ext as Record<string, unknown>;
    if (e["requires"] !== undefined) {
      if (!Array.isArray(e["requires"]) || !e["requires"].every((c) => CAPS.includes(c as Capability))) throw bad(`'deccanxai.requires' must be a subset of ${CAPS.join(", ")}`);
      req.requires = e["requires"] as Capability[];
    }
    if (e["task_class"] !== undefined) {
      if (!TASK_CLASSES.includes(e["task_class"] as TaskClass)) throw bad(`'deccanxai.task_class' must be one of ${TASK_CLASSES.join(", ")}`);
      req.taskClass = e["task_class"] as TaskClass;
    }
  }
  return req;
}

function modelView(m: ModelRecord) {
  const verified = m.state === "accessible" || m.state === "tested";
  return {
    id: `${m.provider}/${m.modelId}`,
    object: "model",
    created: 0,
    owned_by: m.provider,
    x_deccanxai: {
      state: m.state,
      display_name: m.displayName,
      capabilities: m.capabilities,
      ...(m.contextWindow !== undefined ? { context_window: m.contextWindow } : {}),
      ...(m.inputPricePerM !== undefined ? { input_price_per_m: m.inputPricePerM } : {}),
      ...(m.outputPricePerM !== undefined ? { output_price_per_m: m.outputPricePerM } : {}),
      ...(m.lastVerifiedAt ? { last_verified_at: m.lastVerifiedAt } : {}),
      ...(m.accessRequirements ? { access_requirements: m.accessRequirements } : {}),
      ...(verified ? {} : { note: "listed by the provider; access has not been verified" }),
    },
  };
}

const finish = (r: string): "stop" | "length" => (r === "length" ? "length" : "stop");

export function createGateway(opts: GatewayOptions): http.Server {
  const { app } = opts;
  const version = opts.version ?? "0.1.0-alpha.0";
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  const log = opts.log ?? (() => {});

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
    res.end(text);
  };

  const sendError = (res: http.ServerResponse, err: HttpError, requestId: string) =>
    send(res, err.status, { error: { message: err.message, type: err.type, code: err.code, request_id: requestId } }, err.headers);

  async function chatCompletions(req: http.IncomingMessage, res: http.ServerResponse, requestId: string): Promise<void> {
    const chatReq = parseChatBody(await readJson(req, maxBody));
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort(); // client went away: stop spending provider quota
    });
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${requestId}`;

    if (!chatReq.stream) {
      const { response, decision } = await app.router.chat(chatReq, ac.signal);
      send(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: `${response.provider}/${response.model}`,
        choices: [{ index: 0, message: { role: "assistant", content: response.content }, finish_reason: finish(response.finishReason) }],
        usage: {
          prompt_tokens: response.usage.inputTokens,
          completion_tokens: response.usage.outputTokens,
          total_tokens: response.usage.inputTokens + response.usage.outputTokens,
        },
        x_deccanxai: {
          request_id: requestId,
          provider: response.provider,
          usage_provenance: response.usage.provenance,
          attempts: decision.attempts.length,
          failed_over: decision.attempts.some((a) => a.outcome === "error"),
        },
      });
      return;
    }

    let started = false;
    const sse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunkBase = (model: string) => ({ id, object: "chat.completion.chunk", created, model });
    try {
      const { decision, chunks } = app.router.stream(chatReq, ac.signal);
      for await (const c of chunks) {
        const model = decision.chosen ? `${decision.chosen.provider}/${decision.chosen.model}` : chatReq.model;
        if (!started) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
          sse({ ...chunkBase(model), choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
          started = true;
        }
        if (c.delta) sse({ ...chunkBase(model), choices: [{ index: 0, delta: { content: c.delta }, finish_reason: null }] });
        if (c.usage) {
          sse({
            ...chunkBase(model),
            choices: [{ index: 0, delta: {}, finish_reason: finish(c.finishReason ?? "stop") }],
            usage: {
              prompt_tokens: c.usage.inputTokens,
              completion_tokens: c.usage.outputTokens,
              total_tokens: c.usage.inputTokens + c.usage.outputTokens,
            },
            x_deccanxai: { request_id: requestId, usage_provenance: c.usage.provenance, attempts: decision.attempts.length },
          });
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (e) {
      const err = mapError(e);
      if (!started) {
        sendError(res, err, requestId);
        return;
      }
      // Headers already sent: report in-band and end WITHOUT [DONE] so clients can tell it was cut short.
      sse({ error: { message: err.message, type: err.type, code: err.code, request_id: requestId } });
      res.end();
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, requestId: string, who: { principal?: Principal }): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") {
      send(res, 200, { status: "ok", version });
      return;
    }

    const principal = app.auth.authenticate(req.headers["authorization"]);
    if (!principal) throw new HttpError(401, "authentication_error", "invalid_api_key", "missing or invalid API key", { "www-authenticate": "Bearer" });
    who.principal = principal;
    const rl = app.limiter.take(principal.id);
    if (!rl.ok) throw new HttpError(429, "rate_limit_exceeded", "gateway_rate_limited", "too many requests", { "retry-after": String(rl.retryAfterSec) });

    const admin = () => {
      if (principal.role !== "admin") throw new HttpError(403, "permission_error", "admin_required", "this endpoint requires an admin key");
    };

    if (path === "/v1/chat/completions") {
      if (method !== "POST") throw new HttpError(405, "invalid_request_error", "method_not_allowed", "use POST", { allow: "POST" });
      return chatCompletions(req, res, requestId);
    }
    if (path === "/v1/models" && method === "GET") {
      send(res, 200, { object: "list", data: app.registry.list().map(modelView) });
      return;
    }
    if (path === "/v1/usage/summary" && method === "GET") {
      admin();
      send(res, 200, { ...app.ledger.summary(), budgets: app.ledger.getBudgets(), note: "ledger is in-memory and resets on restart; costs are estimates from listed prices" });
      return;
    }
    if (path === "/v1/usage/history" && method === "GET") {
      admin();
      send(res, 200, { data: app.ledger.history(Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100)) });
      return;
    }
    if (path === "/v1/router/decisions" && method === "GET") {
      admin();
      send(res, 200, { data: app.router.recentDecisions(Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50)), stats: app.router.routingStats() });
      return;
    }
    if (path === "/v1/registry/counts" && method === "GET") {
      admin();
      send(res, 200, app.registry.counts());
      return;
    }
    if (path === "/v1/admin/discover" && method === "POST") {
      admin();
      const body = (await readJson(req, maxBody)) as { provider?: unknown };
      const ids = typeof body.provider === "string" ? [body.provider] : [...app.adapters.keys()];
      const results: Array<Record<string, unknown>> = [];
      for (const pid of ids) {
        const ad = app.adapters.get(pid);
        if (!ad) {
          results.push({ provider: pid, ok: false, error: "unknown provider" });
          continue;
        }
        try {
          const n = await app.registry.discover(ad);
          app.registry.markProviderConfigured(pid);
          results.push({ provider: pid, ok: true, models: n });
        } catch (e) {
          results.push({ provider: pid, ok: false, error: redact((e as Error).message) });
        }
      }
      send(res, 200, { results });
      return;
    }
    if (path === "/v1/admin/probe" && method === "POST") {
      admin();
      const body = (await readJson(req, maxBody)) as { models?: unknown };
      // Probes are real requests that consume quota, so models must be listed explicitly.
      if (!Array.isArray(body.models) || body.models.length === 0 || body.models.length > 20 || !body.models.every((m) => typeof m === "string")) {
        throw bad("'models' must be a list of 1-20 'provider/model' strings");
      }
      const results: Array<Record<string, unknown>> = [];
      for (const full of body.models as string[]) {
        const slash = full.indexOf("/");
        const pid = slash > 0 ? full.slice(0, slash) : "";
        const ad = app.adapters.get(pid);
        if (!ad) {
          results.push({ model: full, outcome: "error", reason: "unknown provider" });
          continue;
        }
        const mid = full.slice(slash + 1);
        if (!app.registry.get(pid, mid)) {
          app.registry.upsertDiscovered([{ provider: pid, modelId: mid, displayName: mid, capabilities: [], state: "discovered" }]);
        }
        const r = await app.registry.probe(ad, mid);
        results.push({ model: full, ...r });
      }
      send(res, 200, { results });
      return;
    }

    throw new HttpError(404, "invalid_request_error", "not_found", `no route for ${method} ${path}`);
  }

  return http.createServer((req, res) => {
    const requestId = randomUUID();
    const t0 = Date.now();
    const who: { principal?: Principal } = {};
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      log({
        ts: new Date().toISOString(),
        requestId,
        method: req.method,
        path: (req.url ?? "").split("?")[0],
        status: res.statusCode,
        ms: Date.now() - t0,
        principal: who.principal?.id ?? null,
      });
    });
    handle(req, res, requestId, who).catch((e: unknown) => {
      const err = mapError(e);
      if (err.status === 500) log({ ts: new Date().toISOString(), requestId, level: "error", detail: redact(String((e as Error)?.stack ?? e)).slice(0, 2000) });
      if (!res.headersSent) sendError(res, err, requestId);
      else res.end();
    });
  });
}
