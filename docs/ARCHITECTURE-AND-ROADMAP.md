# DECCANXAI: Architecture Analysis, Technical Decisions and Development Roadmap

DECCANX Semiconductor Engineering. Status: proposal for review, nothing implemented yet.

---

## 1. Analysis of the specification

### 1.1 What the product really is
DECCANXAI is five products that share one core. Treating them as one monolith is the main delivery risk.

| Layer | What it is | Depends on |
|---|---|---|
| **Gateway + Router** | OpenAI-compatible API, provider adapters, routing, failover, accounting | nothing |
| **Credential + Usage plane** | Encrypted keys, budgets, measured token/cost ledger | Gateway |
| **Agent Core** | Orchestrator, sub-agents, checkpoints, verification | Gateway, tool runtime |
| **Local Runtime** | Sandboxed terminal/files/browser/computer-use with permission levels | Agent Core |
| **Studio + EDA module** | Dashboard, hardware-engineering adapters | all of the above |

Layers 1-2 are useful on their own and are the right first release. Layers 3-5 inherit their correctness and security from the layers below.

### 1.2 Requirements that shape the architecture
These are the spec's non-negotiables. I treat them as testable acceptance criteria, not slogans.

1. **No fabricated data.** Every dashboard figure must come from a stored measurement. Estimated values carry an `estimated` flag end-to-end (DB column, API field, UI badge).
2. **No completion claims without evidence.** The Verification Agent must attach artifacts (logs, exit codes, waveform/report files) to a task before it can reach `COMPLETED`. This is enforced by the state machine, not by prompting.
3. **No unrestricted execution.** Model output is never a command; it is a *proposed tool call* that passes a policy engine.
4. **Catalogue != access.** The model registry keeps five distinct states: discovered, configured, accessible, tested, unavailable.
5. **No credential extraction, no quota bypass.** Only BYOK, official free tiers, local and community endpoints.
6. **Phased delivery with evidence**: tests, security checks, docs, demo, known limitations per phase.

### 1.3 Gaps and tensions in the spec to resolve early
- **"Premium-first" vs. quota/cost.** Needs a defined scoring function with user-tunable weights, otherwise "premium-first" and "maximum cost" conflict silently. See 3.3.
- **"1,000+ model endpoints."** Real provider catalogues are in the low hundreds. Reaching 1,000+ realistically means aggregators (OpenRouter-style), local servers and community endpoints. Design the registry for that scale, but do not promise it as a launch number.
- **Prompt-injection defenses** are listed once, but affect every tool that reads untrusted content (web pages, files, tool output). They need a design (3.6), not a checklist item.
- **Computer-use on Windows/macOS/Linux** has very different OS permission models. It is the highest-risk and most platform-specific component, so it comes late.
- **Commercial EDA licensing** (Questa, Vivado, Quartus) cannot be tested in public CI. Open-source tools (Verilator, Icarus, Yosys, OpenROAD) must be the CI baseline.
- **Multi-tenant vs. single-user.** Both are required. The cleanest approach is one codebase with tenant-scoped data access from day one, and a single-user mode that is just "one tenant, SQLite".
- **Unspecified:** license choice, governance, name/trademark check for "DECCANXAI", telemetry policy (recommend none by default).

---

## 2. Technical decisions

Each decision lists the choice, the reason, and the main alternative.

| # | Area | Decision | Rationale | Alternative |
|---|---|---|---|---|
| D1 | Core language | **TypeScript (Node 22 LTS)** for gateway, router, orchestrator, registry | One language across API, SDK, web and adapters; strong typing for provider schemas; large contributor pool; excellent streaming (SSE) support | Go (faster, but splits the stack from web/SDK) |
| D2 | Monorepo | **pnpm workspaces + Turborepo** | Matches the proposed `apps/ services/ packages/` layout; incremental builds | Nx |
| D3 | HTTP framework | **Fastify** + Zod schemas (OpenAPI generated from them) | Fast, schema-first, plugin model suits provider adapters | Hono |
| D4 | Datastore | **PostgreSQL** (multi-user) and **SQLite** (single-user local) behind one repository interface, **Drizzle ORM** migrations | Zero-dependency local install, scalable server mode | Postgres only (simpler, worse local UX) |
| D5 | Cache/queues | **Redis** optional; in-process fallback for single-user. Job queue via **BullMQ** (server mode) | Rate-limit counters, circuit-breaker state, task queue | NATS |
| D6 | Credential security | **Envelope encryption**: per-record data key (AES-256-GCM) wrapped by a master key. Master key from env/OS keychain, with a KMS/Vault plug-in interface. Keys are write-only via API; only last-4 shown | Meets "encrypted at rest, never exposed"; works offline | Plain DB encryption (no key separation) |
| D7 | Provider layer | **Adapter interface** (`listModels`, `chat`, `stream`, `embed`, `healthCheck`, `usage`) with a shared OpenAI-compatible base adapter, plus native adapters for Anthropic and Gemini | Most providers are OpenAI-compatible, so the base adapter covers many. Native adapters preserve provider-specific features | One generic client (loses features) |
| D8 | Internal message format | **Provider-neutral canonical schema** (messages, tool calls, content parts, usage) translated at the adapter edge | Prevents provider lock-in; enables mid-conversation failover | Pass-through OpenAI format |
| D9 | Router design | **Pure, deterministic scoring function** + pluggable policies; routing decisions are logged with the full candidate score table | Testable, explainable, replayable | LLM-based router (non-deterministic; optional later as a classifier input only) |
| D10 | Task complexity classification | Start with **heuristics + user hints** (tool use, context length, code/vision flags). Add an optional small-model classifier in Phase 2b, evaluated against a labelled set | Avoid depending on an LLM to choose an LLM at launch | Classifier from day one |
| D11 | Agent framework | **Own thin orchestration layer** (explicit state machine, typed messages, checkpoint to DB) rather than adopting a large agent framework | Spec demands verification gates, approvals, pause/resume; these are easier to guarantee in a small, owned core | LangGraph (faster start, harder to enforce invariants) |
| D12 | Tool protocol | **MCP-compatible tool interface** in `tool-sdk` | Reuse the existing ecosystem; third parties can bring tools | Custom only |
| D13 | Sandbox | **Container-based by default** (rootless Docker/Podman, no network unless granted, resource limits). Linux hardening via seccomp + bubblewrap for the lighter mode. Windows via Job Objects + restricted token, or WSL2 container | Real isolation, not just allowlists | Allowlist-only (insufficient alone) |
| D14 | Local runtime | **Rust** small daemon for the privileged boundary (policy enforcement, process supervision, emergency stop) with a TS client | Memory safety at the highest-risk boundary; small audited surface | TS-only |
| D15 | Browser agent | **Playwright** with isolated profiles, separate from the user's real profile by default | Mature, cross-platform | CDP directly |
| D16 | Computer-use | **Deferred**; per-OS accessibility/screen APIs behind the Level-4 permission with per-app grants | Highest risk, so last | n/a |
| D17 | Web UI | **React + Vite + TanStack Router/Query**, Tailwind with design tokens (light + navy themes), Radix primitives for accessibility | Meets accessibility and theming goals | Next.js (SSR not needed for a dashboard) |
| D18 | Desktop shell | **Tauri** wrapping the web UI and bundling the local runtime | Small footprint, native keychain access | Electron |
| D19 | Observability | **OpenTelemetry** traces/metrics, structured JSON logs with a central secret-redaction filter | Request tracking requirement; vendor-neutral | Custom logging |
| D20 | Auth | Local accounts + **OIDC** for enterprise SSO; **RBAC** roles (owner, admin, developer, viewer); scoped API tokens; sessions via httpOnly cookies | Spec's auth/RBAC/tenant isolation | Third-party IdP only |
| D21 | Memory / retrieval | Postgres **pgvector** (SQLite: sqlite-vec) with per-project namespaces; retention policies per scope | No extra infrastructure; isolation by row-level tenant/project IDs | Dedicated vector DB |
| D22 | EDA integration | **Python-friendly adapter processes** invoked through the sandbox; each adapter outputs a normalized result schema (status, exit code, log paths, metrics). Open-source tools are the CI baseline | Commercial tools can't run in public CI; the normalized schema makes evidence checkable | Direct shell calls |
| D23 | License | **Apache-2.0** recommended (patent grant, enterprise-friendly). Alternative AGPL-3.0 if protecting against closed SaaS forks matters. *Needs your decision.* | | MIT |
| D24 | Quality gates | Vitest, Playwright e2e, property tests for the router, contract tests per adapter (recorded fixtures plus opt-in live tests), CodeQL, Dependabot, gitleaks, SBOM, license scanning | Security and reliability section of the spec | |

---

## 3. Architecture

### 3.1 Component view

```
                       +-------------------------------+
                       |      Studio (web / desktop)    |
                       +---------------+---------------+
                                       | REST + SSE + WebSocket
+------------------+     +-------------v---------------+     +------------------+
| 3rd-party SDK    +---->|           GATEWAY            |<----+ OpenAI-compatible |
| clients          |     | authn, RBAC, rate limit,     |     | clients/tools     |
+------------------+     | request IDs, validation      |     +------------------+
                         +---+--------+--------+--------+
                             |        |        |
              +--------------v-+  +---v-----+  +v------------------+
              |     ROUTER     |  | AGENT   |  | CREDENTIAL MANAGER |
              | score, retry,  |  | ORCHES- |  | envelope encryption|
              | failover,      |  | TRATOR  |  | key lifecycle      |
              | circuit breaker|  | state   |  +--------------------+
              +---+-------+----+  | machine |
                  |       |       +----+----+      +--------------------+
   +--------------v-+  +--v----------+ |           | MODEL REGISTRY     |
   | PROVIDER       |  | USAGE       | |           | 5-state catalogue  |
   | ADAPTERS       |  | MONITOR     | |           +--------------------+
   | (Anthropic,    |  | ledger:     | |
   | OpenAI, Gemini,|  | measured vs | |
   | compat, local) |  | estimated   | |
   +----------------+  +-------------+ |
                                       | tool calls (proposed)
                         +-------------v--------------+
                         |   POLICY ENGINE (Rust)      |
                         | levels 1-5, allowlists,     |
                         | approvals, audit, e-stop    |
                         +-------------+--------------+
                                       |
        +----------+-----------+-------+------+-------------+
        | Sandbox  | Terminal  | Files | Browser | Computer-use |   EDA adapters
        +----------+-----------+-------+---------+--------------+   (Verilator, Yosys...)
```

### 3.2 Request lifecycle (chat completion)
1. Gateway authenticates, assigns a request ID, validates against the schema.
2. Router builds the candidate set from the registry, keeping only models that are **accessible** (credential valid, not breaker-open, within budget).
3. Router scores candidates, picks the best, and records the full score table.
4. Adapter translates the canonical request, streams the response, and counts tokens.
5. On a retryable failure (429, 5xx, timeout) the router applies backoff and then fails over to the next candidate, preserving the canonical conversation state.
6. Usage Monitor writes a ledger row: provider-reported tokens (`measured`) or tokenizer-computed (`estimated`), the cost basis, and latency.

### 3.3 Routing score (initial, configurable)
```
eligible(m) = accessible(m) AND capabilities(m) ⊇ required AND ctx(m) >= needed
              AND within_budget(m) AND breaker(m) != open

score(m) = w_q * quality_tier(m, task_class)
         + w_r * reliability(m)        // rolling success rate
         - w_c * est_cost(m)
         - w_l * p50_latency(m)
         + w_u * user_priority(m)
```
- "Premium-first" is a **weight profile** (high `w_q`, low `w_c`), not a hardcoded model list.
- Quality tiers come from a maintainable data file with per-task-class ratings, user-overridable. They are never hardcoded in router code.
- Hard constraints (budget, capability, context) are filters, not weights, so a cost cap can never be outscored.

### 3.4 Agent task state machine
```
CREATED -> PLANNED -> RUNNING -> AWAITING_APPROVAL <-> RUNNING
RUNNING -> VERIFYING -> COMPLETED
RUNNING/VERIFYING -> FAILED | PAUSED | CANCELLED
```
- `COMPLETED` is reachable only from `VERIFYING` with at least one evidence artifact attached by the Verification Agent (e.g. a simulator log with exit code and pass/fail summary).
- Every transition is checkpointed, so pause/resume/retry rebuild from the DB.
- The 15 agents are **roles** (system prompt + tool allowlist + preferred model profile) over one runtime, not 15 separate codebases. Start with Orchestrator, Planner, Coder, Verifier, Terminal; add the rest as their tools exist.

### 3.5 Permission model (Local Runtime)
| Level | Grants | Default |
|---|---|---|
| 1 | Read-only on listed paths | on when a workspace is added |
| 2 | Create/edit files inside approved project dirs | off |
| 3 | Run allowlisted commands inside the workspace sandbox | off |
| 4 | Operate specific authorized apps (per-app grant) | off |
| 5 | Sensitive/destructive actions | **every action needs explicit approval, never persistent** |

Enforcement lives in the policy engine, outside the model's reach: path canonicalization (no `..`/symlink escape), env scrubbing so secrets never enter the sandbox, timeouts, process-tree kill, a global emergency stop, and an append-only hash-chained audit log.

### 3.6 Prompt-injection defense (design)
- Content from web/files/tool output is tagged **untrusted** and kept in a separate channel from instructions.
- Untrusted content can never directly grant a permission or trigger a Level 3+ action. Such actions require the policy engine to see a user-originated approval.
- Tool outputs are schema-validated and size-limited before re-entering context.
- Red-team test suite (known injection corpus) runs in CI against the orchestrator with a mock model.

### 3.7 Data model (core tables)
`tenants`, `users`, `roles`, `api_tokens`, `providers`, `credentials` (ciphertext + wrapped key + version), `models` (state enum + last_verified_at), `routing_profiles`, `budgets`, `requests`, `usage_ledger` (tokens_in/out/cached, `measured|estimated`, cost, cost_source), `tasks`, `task_events`, `artifacts`, `approvals`, `audit_log`, `memories` (scope: conversation/project/task/user), `workspaces`, `grants`.

Every row carries `tenant_id`; row-level security enforced in Postgres and a repository-layer guard in SQLite mode.

---

## 4. Roadmap

Each phase ends with: working implementation, unit + integration tests, security review, docs, a demo script, and a written **Known Limitations** section. A phase is not "done" until its exit criteria are met with evidence (CI run links, logs).

### Phase 0: Foundation (about 1-2 weeks)
- Repo scaffold, license, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CI (lint, test, CodeQL, gitleaks, dependency audit).
- Canonical message schema, adapter interface, error taxonomy, ADRs for decisions D1-D24.
- **Exit:** CI green on an empty-but-wired monorepo; ADRs merged; license decided.

### Phase 1: Gateway + provider adapters (about 3-4 weeks)
- OpenAI-compatible `/v1/chat/completions` (+ streaming), `/v1/models`.
- Adapters: OpenAI-compatible base, Anthropic, Gemini, Ollama/llama.cpp/vLLM local.
- Contract tests with recorded fixtures; opt-in live tests with your own keys.
- **Exit:** the same request works against ≥3 providers plus one local model; streaming verified; an OpenAI SDK client works unmodified.

### Phase 2: Router + model discovery + fallback (about 3-4 weeks)
- Dynamic model discovery, 5-state registry, health probes ("accessible/tested" come from real probe calls).
- Scoring function, retries with exponential backoff and jitter, rate-limit header handling, circuit breakers.
- Fault-injection tests (429 storms, mid-stream disconnect, timeouts).
- **Exit:** failover demonstrated under injected faults with the score table in logs; property tests prove hard constraints are never violated.

### Phase 3: Credentials + token accounting (about 3 weeks)
- Envelope-encrypted credential store, validate/test/rotate/delete, write-only API.
- Usage ledger (measured vs. estimated), budgets, alerts, hard stops.
- **Exit:** security review confirms no key appears in responses, logs, or error traces (automated log-scan test); ledger reconciles against provider-reported usage within a documented tolerance.

**First public release (v0.1) after Phase 3:** a self-hosted multi-provider gateway with routing, budgets, and honest accounting.

### Phase 4: Agent orchestration (about 4-5 weeks)
- State machine, checkpoints, pause/resume/cancel/retry, task events.
- Orchestrator + Planner + Coder + Verifier, with the evidence-gated completion rule.
- Tool SDK (MCP-compatible), memory v1 (project/task).
- **Exit:** a multi-step task survives a process restart and resumes; a task with no evidence cannot reach `COMPLETED` (tested).

### Phase 5: Local runtime, terminal, files (about 4-5 weeks)
- Rust policy daemon, sandbox, permission Levels 1-3, audit log, emergency stop.
- **Exit:** adversarial test suite (path traversal, symlink escape, env-secret leakage, fork bombs, timeouts) passes; independent security review of the daemon.

### Phase 6: Browser + computer-use (about 5-6 weeks)
- Playwright browser agent in isolated profiles; prompt-injection test corpus.
- Computer-use (Level 4) per-app grants, starting with one OS.
- **Exit:** injection suite passes; no action outside granted apps; documented per-OS limitations.

### Phase 7: Hardware engineering / EDA (about 4-6 weeks)
- Capability registry (installed/available/configured/licence-verified/execution-tested).
- Adapters in this order: Verilator, Icarus, Yosys, OpenROAD, then Vivado/Quartus/Questa for users with licences.
- Normalized result schema; Verification Agent consumes it.
- **Exit:** a reference design (e.g. a small AXI-Lite peripheral) goes through generate, lint, simulate, synthesize, with logs as evidence in CI. The full "AXI DMA controller" scenario is a **stretch milestone**, reported honestly with pass/fail results, not assumed.

### Phase 8: Studio dashboard + analytics (about 5-6 weeks)
- Build against the real APIs from earlier phases (it can start in parallel from Phase 3 for provider/usage screens).
- All 19 sections ship incrementally; empty states instead of placeholder data.
- **Exit:** automated check that no dashboard figure lacks a backing API source; accessibility audit (WCAG 2.2 AA); e2e tests for core flows.

### Phase 9: Multi-user + deployment (about 3-4 weeks)
- RBAC, OIDC, tenant isolation, Docker Compose + Helm, installers per OS, backup/restore.
- **Exit:** cross-tenant access test suite passes; restore from backup verified.

### Phase 10: Performance, reliability, security hardening (ongoing, about 4 weeks to first pass)
- Load tests (target numbers set after Phase 2 baselines, not guessed now), soak tests, chaos tests, third-party penetration test, dependency/SBOM audit.
- **Exit:** published benchmark and security reports; v1.0 criteria met.

Indicative total to v1.0 with a small team (4-6 engineers): about 9-12 months. This is an estimate, to be revised after Phase 1 velocity is measured.

---

## 5. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Provider API changes break adapters | High | Contract tests, per-adapter versioning, opt-in nightly live checks |
| Sandbox escape or policy bypass | Critical | Rust policy boundary, defense in depth (container + policy), external review before Level 3+ ships |
| Prompt injection via browsed content | Critical | Untrusted-content channel, approval gates, red-team suite |
| Credential leakage | Critical | Write-only API, central redaction, log-scan tests, envelope encryption |
| Scope creep from the 19 UI sections / 15 agents | High | Ship thin vertical slices; add each only when its backing service exists |
| Provider ToS issues with automated routing/aggregation | Medium | BYOK only, per-provider notes in docs, no credential pooling across users |
| Commercial EDA not testable in CI | Medium | OSS tools as the baseline; licensed tools marked "execution-tested" only on user machines |
| Overpromising ("unlimited tokens", autonomy) | Reputation | Capability claims generated from the registry/test results; wording rules in docs |

---

## 6. Decisions needed from you before Phase 0

1. **License:** Apache-2.0 (recommended) or AGPL-3.0?
2. **Stack confirmation:** TypeScript core + Rust policy daemon, or do you prefer a different primary language?
3. **First-release scope:** agree that v0.1 = Phases 0-3 (gateway, router, credentials, accounting).
4. **Team and timeline:** how many contributors, and is there a target date for a public v0.1?
5. **Primary OS for early development/testing** of the local runtime (Windows, Linux, or macOS)?
6. **Name check:** confirm "DECCANXAI" is cleared for use as a project and trademark name.

## 7. Immediate next steps (once the above are answered)
1. Create the repo skeleton and CI (Phase 0), with ADRs for D1-D24.
2. Define the canonical message and usage schemas, and review them before any adapter work.
3. Implement the OpenAI-compatible adapter first and get one end-to-end streaming request passing, as the first piece of verifiable evidence.
