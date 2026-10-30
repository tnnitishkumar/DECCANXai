/**
 * Canonical, provider-neutral types for DECCANXAI.
 * Adapters translate to/from these at the edge (ADR D8).
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ChatRequest {
  /** Either a concrete "provider/model" id, or "auto" to let the router choose. */
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Capabilities the caller requires; router filters on these (hard constraints). */
  requires?: Capability[];
  /** Task class hint used for quality-tier lookup. */
  taskClass?: TaskClass;
}

export type Capability = "tools" | "vision" | "reasoning" | "json";
export type TaskClass = "general" | "coding" | "reasoning" | "chat";

/** Whether a number came from the provider (measured) or was computed locally (estimated). */
export type Provenance = "measured" | "estimated";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  provenance: Provenance;
}

export interface ChatResponse {
  id: string;
  model: string;
  provider: string;
  content: string;
  finishReason: "stop" | "length" | "error" | "other";
  usage: Usage;
}

export interface StreamChunk {
  delta: string;
  /** Present on the final chunk when the provider reports usage. */
  usage?: Usage;
  finishReason?: ChatResponse["finishReason"];
}

/** Model access states. Listing a model never implies access (spec section 9). */
export type ModelState =
  | "discovered"
  | "configured"
  | "accessible"
  | "tested"
  | "unavailable";

export interface ModelRecord {
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow?: number;
  /** USD per 1M tokens; undefined = unknown (never guessed). */
  inputPricePerM?: number;
  outputPricePerM?: number;
  capabilities: Capability[];
  state: ModelState;
  /** Free-text, e.g. "BYOK key required". */
  accessRequirements?: string;
  lastVerifiedAt?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<ModelRecord[]>;
  chat(req: ChatRequest, modelId: string, signal?: AbortSignal): Promise<ChatResponse>;
  stream(req: ChatRequest, modelId: string, signal?: AbortSignal): AsyncGenerator<StreamChunk>;
  healthCheck(signal?: AbortSignal): Promise<boolean>;
}

export * from "./errors.ts";
export * from "./redact.ts";
