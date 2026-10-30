import type { Capability, ModelRecord, ProviderAdapter } from "#shared";
import { OpenAICompatibleAdapter } from "#adapters";
import { ModelRegistry } from "#registry";
import { UsageLedger, type BudgetAlert, type BudgetRule } from "#usage";
import { CircuitBreaker, PROFILES, QualityTable, Router, type QualityRule, type RetryPolicy } from "#router";
import { Authenticator, RateLimiter } from "#security";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ModelHintConfig {
  displayName?: string;
  contextWindow?: number;
  inputPricePerM?: number;
  outputPricePerM?: number;
  capabilities?: Capability[];
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  /** NAME of an environment variable holding the key. The key itself is never in config. */
  apiKeyEnv?: string;
  timeoutMs?: number;
  /** Operator priority in [0,1]. */
  priority?: number;
  models?: Record<string, ModelHintConfig>;
}

export interface AppConfig {
  host?: string;
  port?: number;
  providers: ProviderConfig[];
  qualityRules?: QualityRule[];
  weightProfile?: keyof typeof PROFILES;
  budgets?: BudgetRule[];
  retry?: Partial<RetryPolicy>;
  /** Explicit models to probe at startup ("provider/model"). Probes are real, tiny requests. */
  probeOnStart?: string[];
  rateLimitPerMinute?: number;
}

const CAPS: Capability[] = ["tools", "vision", "reasoning", "json"];
const FORBIDDEN_KEYS = /^(api[_-]?key|apikey|secret|token|password|authorization)$/i;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rejects any secret-looking field anywhere in the config: keys belong in env vars or the vault. */
function assertNoSecrets(v: unknown, path: string): void {
  if (Array.isArray(v)) v.forEach((x, i) => assertNoSecrets(x, `${path}[${i}]`));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.test(k)) {
        throw new ConfigError(`${path}.${k}: secrets must not be stored in the config file; use 'apiKeyEnv' to name an environment variable`);
      }
      assertNoSecrets(x, `${path}.${k}`);
    }
  }
}

export function parseConfig(raw: unknown): AppConfig {
  if (!isObj(raw)) throw new ConfigError("config must be a JSON object");
  assertNoSecrets(raw, "config");
  const providersRaw = raw["providers"];
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) throw new ConfigError("config.providers must be a non-empty array");

  const seen = new Set<string>();
  const providers: ProviderConfig[] = providersRaw.map((p, i) => {
    const at = `providers[${i}]`;
    if (!isObj(p)) throw new ConfigError(`${at} must be an object`);
    const id = p["id"];
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new ConfigError(`${at}.id must match [a-z0-9][a-z0-9_-]* (no '/')`);
    if (seen.has(id)) throw new ConfigError(`${at}.id '${id}' is duplicated`);
    seen.add(id);
    const baseUrl = p["baseUrl"];
    if (typeof baseUrl !== "string") throw new ConfigError(`${at}.baseUrl is required`);
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new ConfigError(`${at}.baseUrl is not a valid URL`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError(`${at}.baseUrl must be http(s)`);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol === "http:" && !loopback && p["apiKeyEnv"]) {
      throw new ConfigError(`${at}: refusing to send an API key over plain http to a non-local host`);
    }
    const out: ProviderConfig = { id, baseUrl };
    if (p["apiKeyEnv"] !== undefined) {
      if (typeof p["apiKeyEnv"] !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(p["apiKeyEnv"])) throw new ConfigError(`${at}.apiKeyEnv must be an environment variable name`);
      out.apiKeyEnv = p["apiKeyEnv"];
    }
    if (p["timeoutMs"] !== undefined) {
      if (typeof p["timeoutMs"] !== "number" || p["timeoutMs"] <= 0) throw new ConfigError(`${at}.timeoutMs must be a positive number`);
      out.timeoutMs = p["timeoutMs"];
    }
    if (p["priority"] !== undefined) {
      if (typeof p["priority"] !== "number" || p["priority"] < 0 || p["priority"] > 1) throw new ConfigError(`${at}.priority must be within [0,1]`);
      out.priority = p["priority"];
    }
    if (p["models"] !== undefined) {
      if (!isObj(p["models"])) throw new ConfigError(`${at}.models must be an object`);
      const models: Record<string, ModelHintConfig> = {};
      for (const [mid, h] of Object.entries(p["models"])) {
        if (!isObj(h)) throw new ConfigError(`${at}.models.${mid} must be an object`);
        const hint: ModelHintConfig = {};
        for (const f of ["contextWindow", "inputPricePerM", "outputPricePerM"] as const) {
          const v = h[f];
          if (v === undefined) continue;
          if (typeof v !== "number" || v < 0) throw new ConfigError(`${at}.models.${mid}.${f} must be a non-negative number`);
          hint[f] = v;
        }
        if (typeof h["displayName"] === "string") hint.displayName = h["displayName"];
        if (h["capabilities"] !== undefined) {
          if (!Array.isArray(h["capabilities"]) || !h["capabilities"].every((c) => CAPS.includes(c as Capability))) {
            throw new ConfigError(`${at}.models.${mid}.capabilities must be a subset of ${CAPS.join(", ")}`);
          }
          hint.capabilities = h["capabilities"] as Capability[];
        }
        models[mid] = hint;
      }
      out.models = models;
    }
    return out;
  });

  const cfg: AppConfig = { providers };
  if (raw["host"] !== undefined) {
    if (typeof raw["host"] !== "string") throw new ConfigError("config.host must be a string");
    cfg.host = raw["host"];
  }
  if (raw["port"] !== undefined) {
    if (typeof raw["port"] !== "number" || !Number.isInteger(raw["port"]) || raw["port"] < 0 || raw["port"] > 65535) throw new ConfigError("config.port must be an integer 0-65535");
    cfg.port = raw["port"];
  }
  if (raw["weightProfile"] !== undefined) {
    if (typeof raw["weightProfile"] !== "string" || !(raw["weightProfile"] in PROFILES)) throw new ConfigError(`config.weightProfile must be one of ${Object.keys(PROFILES).join(", ")}`);
    cfg.weightProfile = raw["weightProfile"] as keyof typeof PROFILES;
  }
  if (raw["qualityRules"] !== undefined) {
    if (!Array.isArray(raw["qualityRules"])) throw new ConfigError("config.qualityRules must be an array");
    cfg.qualityRules = raw["qualityRules"] as QualityRule[];
    try {
      new QualityTable(cfg.qualityRules); // validates regexes and ranges
    } catch (e) {
      throw new ConfigError(`config.qualityRules: ${(e as Error).message}`);
    }
  }
  if (raw["budgets"] !== undefined) {
    if (!Array.isArray(raw["budgets"])) throw new ConfigError("config.budgets must be an array");
    cfg.budgets = (raw["budgets"] as unknown[]).map((b, i) => {
      if (!isObj(b) || typeof b["id"] !== "string" || (b["window"] !== "day" && b["window"] !== "month")) {
        throw new ConfigError(`budgets[${i}] needs a string id and window 'day'|'month'`);
      }
      for (const f of ["maxTokens", "maxCostUsd", "maxRequests"]) {
        if (b[f] !== undefined && (typeof b[f] !== "number" || (b[f] as number) < 0)) throw new ConfigError(`budgets[${i}].${f} must be a non-negative number`);
      }
      return { scope: {}, ...b } as unknown as BudgetRule;
    });
  }
  if (raw["retry"] !== undefined) {
    if (!isObj(raw["retry"])) throw new ConfigError("config.retry must be an object");
    cfg.retry = raw["retry"] as Partial<RetryPolicy>;
  }
  if (raw["probeOnStart"] !== undefined) {
    if (!Array.isArray(raw["probeOnStart"]) || !raw["probeOnStart"].every((s) => typeof s === "string" && s.includes("/"))) {
      throw new ConfigError("config.probeOnStart must be an array of 'provider/model' strings");
    }
    cfg.probeOnStart = raw["probeOnStart"] as string[];
  }
  if (raw["rateLimitPerMinute"] !== undefined) {
    if (typeof raw["rateLimitPerMinute"] !== "number" || raw["rateLimitPerMinute"] < 1) throw new ConfigError("config.rateLimitPerMinute must be >= 1");
    cfg.rateLimitPerMinute = raw["rateLimitPerMinute"];
  }
  return cfg;
}

export interface App {
  config: AppConfig;
  adapters: Map<string, ProviderAdapter>;
  registry: ModelRegistry;
  ledger: UsageLedger;
  router: Router;
  auth: Authenticator;
  limiter: RateLimiter;
}

export function buildApp(
  config: AppConfig,
  env: Record<string, string | undefined>,
  opts: { onAlert?: (a: BudgetAlert) => void; fetchImpl?: typeof fetch } = {},
): App {
  const adapters = new Map<string, ProviderAdapter>();
  const priorities: Record<string, number> = {};
  for (const p of config.providers) {
    let apiKey: string | undefined;
    if (p.apiKeyEnv) {
      apiKey = env[p.apiKeyEnv];
      if (!apiKey) throw new ConfigError(`provider '${p.id}': environment variable ${p.apiKeyEnv} is not set`);
    }
    const hints: Record<string, Partial<ModelRecord>> = {};
    for (const [mid, h] of Object.entries(p.models ?? {})) hints[mid] = { ...h };
    adapters.set(
      p.id,
      new OpenAICompatibleAdapter({
        id: p.id,
        baseUrl: p.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        modelHints: hints,
      }),
    );
    if (p.priority !== undefined) priorities[p.id] = p.priority;
  }

  const registry = new ModelRegistry();
  const ledger = new UsageLedger(opts.onAlert ? { onAlert: opts.onAlert } : {});
  if (config.budgets) ledger.setBudgets(config.budgets);
  const router = new Router({
    adapters: [...adapters.values()],
    registry,
    ledger,
    quality: new QualityTable(config.qualityRules ?? []),
    weights: PROFILES[config.weightProfile ?? "premiumFirst"],
    breaker: new CircuitBreaker(),
    providerPriority: priorities,
    ...(config.retry ? { retry: config.retry } : {}),
  });
  return {
    config,
    adapters,
    registry,
    ledger,
    router,
    auth: Authenticator.fromEnv(env),
    limiter: new RateLimiter(config.rateLimitPerMinute ?? 120),
  };
}
