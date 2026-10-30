/**
 * TEST DOUBLE ONLY. A real HTTP server that speaks the OpenAI wire format so adapters,
 * the router and the gateway can be exercised over actual sockets (streaming, status
 * codes, headers) without any provider account. It is never used at runtime.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockProviderOptions {
  models?: string[];
  /** If set, requests must carry "Authorization: Bearer <apiKey>" else 401. */
  apiKey?: string;
  reply?: string;
  /** Report token usage? false simulates providers that omit it. */
  reportUsage?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  delayMs?: number;
  /** Statuses returned (in order) before requests start succeeding. */
  failures?: number[];
  retryAfterSec?: number;
  /** Always fail with this status (permanent outage). */
  alwaysFail?: number;
  /** For streams: destroy the socket after N content chunks. */
  breakStreamAfter?: number;
  /** For streams: cleanly close the response after N content chunks (no finish_reason, no [DONE]). */
  truncateStreamAfter?: number;
}

export interface RecordedCall {
  path: string;
  method: string;
  hadAuth: boolean;
  body: any;
}

export interface MockProvider {
  url: string;
  calls: RecordedCall[];
  setFailures(f: number[]): void;
  setAlwaysFail(status: number | undefined): void;
  close(): Promise<void>;
}

export async function startMockProvider(opts: MockProviderOptions = {}): Promise<MockProvider> {
  const calls: RecordedCall[] = [];
  let failures = [...(opts.failures ?? [])];
  let alwaysFail = opts.alwaysFail;
  const reply = opts.reply ?? "Hello from mock";
  const models = opts.models ?? ["mock-model"];
  const reportUsage = opts.reportUsage ?? true;
  const pt = opts.promptTokens ?? 11;
  const ct = opts.completionTokens ?? 7;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const auth = req.headers["authorization"];
      calls.push({ path: req.url ?? "", method: req.method ?? "", hadAuth: typeof auth === "string", body });

      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));

      if (opts.apiKey && auth !== `Bearer ${opts.apiKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }

      const forced = alwaysFail ?? failures.shift();
      if (forced !== undefined) {
        const h: Record<string, string> = { "content-type": "application/json" };
        if (opts.retryAfterSec !== undefined) h["retry-after"] = String(opts.retryAfterSec);
        res.writeHead(forced, h);
        res.end(JSON.stringify({ error: { message: `forced failure ${forced}` } }));
        return;
      }

      if (req.url?.endsWith("/models") && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
        return;
      }

      if (req.url?.endsWith("/chat/completions") && req.method === "POST") {
        const usage = { prompt_tokens: pt, completion_tokens: ct };
        if (body?.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const words = reply.split(" ");
          let sent = 0;
          for (const w of words) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: (sent ? " " : "") + w }, finish_reason: null }] })}\n\n`,
            );
            sent++;
            if (opts.breakStreamAfter !== undefined && sent >= opts.breakStreamAfter) {
              // Let the already-written chunks reach the client first, so "data delivered, then
              // the connection dies" is deterministic rather than a race with the reset.
              await new Promise((r) => setTimeout(r, 50));
              res.socket?.destroy();
              return;
            }
            if (opts.truncateStreamAfter !== undefined && sent >= opts.truncateStreamAfter) {
              res.end(); // looks like a normal EOF to the client
              return;
            }
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
          if (reportUsage) res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            model: body?.model ?? "mock-model",
            choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }],
            ...(reportUsage ? { usage } : {}),
          }),
        );
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    setFailures(f) {
      failures = [...f];
    },
    setAlwaysFail(s) {
      alwaysFail = s;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
