# Contributing
- Node >= 22.18. No install step is needed to run or test: `npm test`, `npm run typecheck` (typecheck needs `typescript` and `@types/node`).
- Every capability needs tests; claims in `docs/STATUS.md` must be backed by a test or a recorded run.
- Never add fabricated data: unknown prices/limits are `undefined`, never `0`. Estimated numbers must carry `provenance: "estimated"`.
- Never commit secrets. New provider support goes in `packages/provider-adapters` behind the `ProviderAdapter` interface.
