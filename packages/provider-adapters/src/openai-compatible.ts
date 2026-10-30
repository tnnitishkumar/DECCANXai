import type {
  Capability,
  ChatRequest,
  ChatResponse,
  ModelRecord,
  ProviderAdapter,
  StreamChunk,
  Usage,
} from "#shared";
import { DeccanError, errorFromStatus, redact } from "#shared";

export interface OpenAICompatibleOptions {
  /** Unique provider id, e.g. "openai", "ollama", "my-vllm". */
  id: string;
  /** Base URL including version prefix, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Optional: local servers often need no key. Never logged. */
  apiKey?: string;
  /** Per-request timeout in ms (default 60s). */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Optional static hints merged into discovered models (e.g. pricing the operator knows). */
  modelHints?: Record<string, Partial<ModelRecord>>;
}

/** Rough local token estimate (~4 chars/token). Always tagged "estimated". */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

interface OAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function usageFrom(u: OAIUsage | undefined, req: ChatRequest, output: string): Usage {
  if (u && typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
    const out: Usage = {
      inputTokens: u.prompt_tokens,
      outputTokens: u.completion_tokens,
      provenance: "measured",
    };
    const cached = u.prompt_tokens_details?.cached_tokens;
    if (typeof cached === "number") out.cachedTokens = cached;
    return out;
  }
  // Provider did not report usage: estimate and say so.
  const input = req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  return { inputTokens: input, outputTokens: estimateTokens(output), provenance: "estimated" };
}

function mapFinish(r: string | null | undefined): ChatResponse["finishReason"] {
  if (r === "stop") return "stop";
  if (r === "length") return "length";
  return "other";
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly hints: Record<string, Partial<ModelRecord>>;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.hints = opts.modelHints ?? {};
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  private signal(external?: AbortSignal): AbortSignal {
    const t = AbortSignal.timeout(this.timeoutMs);
    return external ? AbortSignal.any([t, external]) : t;
  }

  private async request(path: string, init: RequestInit, external?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: this.signal(external) });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new DeccanError("timeout", `${this.id}: request timed out or aborted`);
      }
      throw new DeccanError("unavailable", redact(`${this.id}: network error: ${err.message}`));
    }
    if (!res.ok) {
      const body = redact((await res.text().catch(() => "")).slice(0, 300));
      throw errorFromStatus(
        res.status,
        `${this.id}: HTTP ${res.status}${body ? ` - ${body}` : ""}`,
        parseRetryAfter(res.headers.get("retry-after")),
      );
    }
    return res;
  }

  async listModels(signal?: AbortSignal): Promise<ModelRecord[]> {
    const res = await this.request("/models", { method: "GET", headers: this.headers() }, signal);
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const out: ModelRecord[] = [];
    for (const m of json.data ?? []) {
      if (typeof m.id !== "string") continue;
      const hint = this.hints[m.id] ?? {};
      const capabilities: Capability[] = hint.capabilities ?? [];
      out.push({
        provider: this.id,
        modelId: m.id,
        displayName: hint.displayName ?? m.id,
        capabilities,
        // Listed by the provider != accessible. Probing upgrades this state.
        state: "discovered",
        ...(hint.contextWindow !== undefined ? { contextWindow: hint.contextWindow } : {}),
        ...(hint.inputPricePerM !== undefined ? { inputPricePerM: hint.inputPricePerM } : {}),
        ...(hint.outputPricePerM !== undefined ? { outputPricePerM: hint.outputPricePerM } : {}),
        ...(hint.accessRequirements !== undefined ? { accessRequirements: hint.accessRequirements } : {}),
      });
    }
    return out;
  }

  private body(req: ChatRequest, modelId: string, stream: boolean): string {
    return JSON.stringify({
      model: modelId,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      })),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
    });
  }

  async chat(req: ChatRequest, modelId: string, signal?: AbortSignal): Promise<ChatResponse> {
    const res = await this.request(
      "/chat/completions",
      { method: "POST", headers: this.headers(), body: this.body(req, modelId, false) },
      signal,
    );
    const j = (await res.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
      usage?: OAIUsage;
    };
    const choice = j.choices?.[0];
    if (!choice) throw new DeccanError("unavailable", `${this.id}: response contained no choices`);
    const content = choice.message?.content ?? "";
    return {
      id: j.id ?? `chatcmpl-${Date.now()}`,
      model: j.model ?? modelId,
      provider: this.id,
      content,
      finishReason: mapFinish(choice.finish_reason),
      usage: usageFrom(j.usage, req, content),
    };
  }

  async *stream(req: ChatRequest, modelId: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const res = await this.request(
      "/chat/completions",
      { method: "POST", headers: this.headers(), body: this.body(req, modelId, true) },
      signal,
    );
    if (!res.body) throw new DeccanError("unavailable", `${this.id}: stream had no body`);

    const decoder = new TextDecoder();
    let buffer = "";
    let produced = "";
    let finish: ChatResponse["finishReason"] | undefined;
    let usage: OAIUsage | undefined;

    const handleLine = (line: string): StreamChunk | "done" | undefined => {
      if (!line.startsWith("data:")) return undefined;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return "done";
      let j: {
        choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
        usage?: OAIUsage;
      };
      try {
        j = JSON.parse(data);
      } catch {
        return undefined; // tolerate keep-alives / partial garbage
      }
      if (j.usage) usage = j.usage;
      const c = j.choices?.[0];
      if (c?.finish_reason) finish = mapFinish(c.finish_reason);
      const delta = c?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        produced += delta;
        return { delta };
      }
      return undefined;
    };

    let done = false;
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          const r = handleLine(line);
          if (r === "done") {
            done = true;
            break;
          }
          if (r) yield r;
        }
        if (done) break;
      }
      if (!done && buffer.trim().length > 0) {
        const r = handleLine(buffer.trim());
        if (r === "done") done = true;
        else if (r) yield r;
      }
      // A stream that ends with neither [DONE] nor a finish_reason was cut off (even if the
      // connection closed cleanly). Reporting it as a success would hide a truncated answer.
      if (!done && finish === undefined) {
        throw new DeccanError("unavailable", `${this.id}: stream ended before completion (truncated response)`);
      }
    } catch (e) {
      if (e instanceof DeccanError) throw e;
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new DeccanError("timeout", `${this.id}: stream timed out or aborted`);
      }
      throw new DeccanError("unavailable", redact(`${this.id}: stream interrupted: ${err.message}`));
    }

    yield {
      delta: "",
      usage: usageFrom(usage, req, produced),
      finishReason: finish ?? "stop",
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.listModels(signal);
      return true;
    } catch {
      return false;
    }
  }
}
