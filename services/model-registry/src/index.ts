import type { ModelRecord, ModelState, ProviderAdapter } from "#shared";
import { DeccanError } from "#shared";

/**
 * Model registry (spec section 9).
 *
 * State lifecycle (a listing never implies access):
 *   discovered  - the provider's catalogue lists it
 *   configured  - a credential/endpoint is configured for its provider
 *   accessible  - a real probe call succeeded
 *   tested      - a real user request was served successfully
 *   unavailable - a probe/request proved it cannot be used (auth, not found, ...)
 *
 * Only a real network call can raise a model to accessible/tested.
 */

const RANK: Record<ModelState, number> = {
  unavailable: -1,
  discovered: 0,
  configured: 1,
  accessible: 2,
  tested: 3,
};

export const keyOf = (provider: string, modelId: string) => `${provider}/${modelId}`;

export type ProbeOutcome =
  | { outcome: "accessible" }
  | { outcome: "unavailable"; reason: string }
  | { outcome: "inconclusive"; reason: string };

export class ModelRegistry {
  private models = new Map<string, ModelRecord>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** Merge freshly discovered records. Never downgrades an existing state. */
  upsertDiscovered(records: ModelRecord[]): void {
    for (const r of records) {
      const k = keyOf(r.provider, r.modelId);
      const prev = this.models.get(k);
      if (!prev) {
        this.models.set(k, { ...r, state: "discovered" });
      } else {
        this.models.set(k, {
          ...prev,
          displayName: r.displayName,
          ...(r.contextWindow !== undefined ? { contextWindow: r.contextWindow } : {}),
          ...(r.inputPricePerM !== undefined ? { inputPricePerM: r.inputPricePerM } : {}),
          ...(r.outputPricePerM !== undefined ? { outputPricePerM: r.outputPricePerM } : {}),
          ...(r.capabilities.length > 0 ? { capabilities: r.capabilities } : {}),
        });
      }
    }
  }

  async discover(adapter: ProviderAdapter, signal?: AbortSignal): Promise<number> {
    const found = await adapter.listModels(signal);
    this.upsertDiscovered(found);
    return found.length;
  }

  /** A credential/endpoint exists for this provider: discovered -> configured. */
  markProviderConfigured(provider: string): void {
    for (const [k, m] of this.models) {
      if (m.provider === provider && m.state === "discovered") this.models.set(k, { ...m, state: "configured" });
    }
  }

  private setState(provider: string, modelId: string, state: ModelState, verified: boolean): void {
    const k = keyOf(provider, modelId);
    const m = this.models.get(k);
    if (!m) return;
    this.models.set(k, { ...m, state, ...(verified ? { lastVerifiedAt: this.stamp() } : {}) });
  }

  /**
   * Real, minimal completion call (max 1 token). The only way to reach "accessible"
   * without serving a user request. Costs a negligible amount of quota on paid providers.
   */
  async probe(adapter: ProviderAdapter, modelId: string, signal?: AbortSignal): Promise<ProbeOutcome> {
    try {
      await adapter.chat(
        { model: modelId, messages: [{ role: "user", content: "ping" }], maxTokens: 1 },
        modelId,
        signal,
      );
    } catch (e) {
      if (e instanceof DeccanError) {
        if (e.kind === "auth" || e.kind === "bad_request") {
          this.setState(adapter.id, modelId, "unavailable", true);
          return { outcome: "unavailable", reason: e.message };
        }
        return { outcome: "inconclusive", reason: e.message }; // rate limit / outage: state unchanged
      }
      return { outcome: "inconclusive", reason: (e as Error).message };
    }
    const cur = this.models.get(keyOf(adapter.id, modelId));
    // never downgrade tested; a probe can also rehabilitate an unavailable model
    if (!cur || RANK[cur.state] < RANK["accessible"]) this.setState(adapter.id, modelId, "accessible", true);
    else this.setState(adapter.id, modelId, cur.state, true);
    return { outcome: "accessible" };
  }

  /** A real user request succeeded on this model. */
  markServed(provider: string, modelId: string): void {
    if (!this.models.has(keyOf(provider, modelId))) {
      // served through a pinned id the catalogue never listed: record it honestly
      this.models.set(keyOf(provider, modelId), {
        provider,
        modelId,
        displayName: modelId,
        capabilities: [],
        state: "tested",
        lastVerifiedAt: this.stamp(),
      });
      return;
    }
    this.setState(provider, modelId, "tested", true);
  }

  /** A request proved the model cannot be used right now (auth failure etc.). */
  markUnavailable(provider: string, modelId: string): void {
    this.setState(provider, modelId, "unavailable", true);
  }

  /** Operator-supplied metadata (pricing, context window, capabilities). Never inferred. */
  setMetadata(provider: string, modelId: string, patch: Partial<Omit<ModelRecord, "provider" | "modelId" | "state">>): void {
    const k = keyOf(provider, modelId);
    const m = this.models.get(k);
    if (m) this.models.set(k, { ...m, ...patch });
  }

  get(provider: string, modelId: string): ModelRecord | undefined {
    return this.models.get(keyOf(provider, modelId));
  }

  list(filter: { provider?: string; state?: ModelState } = {}): ModelRecord[] {
    return [...this.models.values()].filter(
      (m) => (!filter.provider || m.provider === filter.provider) && (!filter.state || m.state === filter.state),
    );
  }

  /** Resolve "provider/model" or a bare model id (must be unambiguous). */
  resolve(id: string, knownProviders: string[]): ModelRecord | { error: string } {
    const slash = id.indexOf("/");
    if (slash > 0) {
      const p = id.slice(0, slash);
      if (knownProviders.includes(p)) {
        return this.get(p, id.slice(slash + 1)) ?? { error: `model '${id.slice(slash + 1)}' not in registry for provider '${p}'` };
      }
    }
    const matches = [...this.models.values()].filter((m) => m.modelId === id);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) return { error: `unknown model '${id}'` };
    return { error: `model '${id}' is ambiguous; use provider/model (${matches.map((m) => m.provider).join(", ")})` };
  }

  counts(): Record<ModelState, number> {
    const c: Record<ModelState, number> = { discovered: 0, configured: 0, accessible: 0, tested: 0, unavailable: 0 };
    for (const m of this.models.values()) c[m.state]++;
    return c;
  }
}
