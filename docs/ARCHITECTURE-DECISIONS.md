# Decisions as built (deviations from the proposal)

The proposal (`docs/ARCHITECTURE-AND-ROADMAP.md`) remains the target. What was actually built differs where the build environment forced it:

| Proposal | As built | Why |
|---|---|---|
| pnpm + Turborepo, Fastify, Vitest | **Zero runtime/test dependencies**: Node's built-in `http`, `node:test`, native TypeScript execution (Node >= 22.18), `#alias` imports | The package registry was unreachable while building, and this keeps the supply-chain surface at zero. Fastify/Vitest can be adopted later without touching the core logic |
| Apache-2.0 / TS core / v0.1 = Phases 0-3 | Adopted as the defaults you did not override | Open decisions from the proposal; change them if you disagree |
| SQLite/Postgres + Drizzle | In-memory state | Persistence is the next step before the vault is wired in |
| Rust policy daemon | Not started | Phase 5 |

Core design choices that are implemented: provider-neutral canonical types; pure deterministic scoring with hard filters; premium-first as a weight profile over operator-supplied tiers; access states changed only by real calls; provenance on every token count; fail-closed auth.
