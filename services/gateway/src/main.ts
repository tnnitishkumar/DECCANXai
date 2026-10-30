import { readFileSync } from "node:fs";
import { redact } from "#shared";
import { ConfigError, buildApp, parseConfig } from "./config.ts";
import { createGateway } from "./server.ts";

const logLine = (o: Record<string, unknown>) => console.log(redact(JSON.stringify(o)));

async function main(): Promise<void> {
  const path = process.env["DECCANXAI_CONFIG"] ?? "deccanxai.config.json";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`cannot read config '${path}': ${(e as Error).message}`);
  }
  const config = parseConfig(raw);
  const app = buildApp(config, process.env, {
    onAlert: (a) =>
      logLine({
        level: "warn",
        event: "budget_alert",
        ruleId: a.ruleId,
        alert: a.level, // "warning" (>=80%) or "exceeded"
        metric: a.metric,
        used: a.used,
        limit: a.limit,
      }),
  });

  const host = process.env["HOST"] ?? config.host ?? "127.0.0.1";
  const port = Number(process.env["PORT"] ?? config.port ?? 8787);
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";

  if (!app.auth.configured) {
    // Fail closed: an unauthenticated gateway holds provider credentials and spends real money.
    if (process.env["DECCANXAI_ALLOW_NO_AUTH"] !== "1" || !loopback) {
      throw new ConfigError(
        "no gateway API keys configured. Set GATEWAY_API_KEYS (and GATEWAY_ADMIN_KEYS). " +
          "Auth can only be disabled with DECCANXAI_ALLOW_NO_AUTH=1 while bound to a loopback address.",
      );
    }
    logLine({ level: "warn", event: "auth_disabled", note: "loopback only" });
  }

  // Discovery is best-effort and read-only (a model-list call). It never raises a model above 'configured'.
  for (const [id, adapter] of app.adapters) {
    try {
      const n = await app.registry.discover(adapter);
      app.registry.markProviderConfigured(id);
      logLine({ event: "discovered", provider: id, models: n });
    } catch (e) {
      logLine({ level: "warn", event: "discovery_failed", provider: id, error: (e as Error).message });
    }
  }
  // Probes are real (tiny) requests, so only explicitly listed models are probed.
  for (const full of config.probeOnStart ?? []) {
    const slash = full.indexOf("/");
    const pid = full.slice(0, slash);
    const adapter = app.adapters.get(pid);
    if (!adapter) {
      logLine({ level: "warn", event: "probe_skipped", model: full, reason: "unknown provider" });
      continue;
    }
    const mid = full.slice(slash + 1);
    if (!app.registry.get(pid, mid)) {
      app.registry.upsertDiscovered([{ provider: pid, modelId: mid, displayName: mid, capabilities: [], state: "discovered" }]);
    }
    logLine({ event: "probed", model: full, ...(await app.registry.probe(adapter, mid)) });
  }

  const server = createGateway({ app, log: logLine });
  const shutdown = () => {
    logLine({ event: "shutting_down" });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.listen(port, host, () => logLine({ event: "listening", host, port }));
}

main().catch((e: unknown) => {
  console.error(redact(e instanceof ConfigError ? `configuration error: ${e.message}` : String((e as Error)?.stack ?? e)));
  process.exit(1);
});
