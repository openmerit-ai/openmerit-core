# AGENTS.md

## What this is

openmerit is an external model-merit harness that plugs into pi agent
harnesses. See README.md for the architecture. TypeScript (ESM, NodeNext),
zero runtime dependencies (Node 22+ fetch only); the pi extension under
`extension/` is self-contained (pi loads it via jiti, no build).

## Commands

- `npm run build` — compile `src/` to `dist/`
- `npm run typecheck` — type-check without emitting
- `npm test` — vitest unit tests in `test/`

## Conventions

- All state lives under `~/.openmerit/` (override with `OPENMERIT_HOME`,
  tests must set it to a temp dir). Never hardcode that path outside
  `src/store.ts` and `extension/openmerit.ts`.
- Model ids are OpenRouter-style `"vendor/model"` everywhere.
- The policy gate in `src/policy.ts` is the only place that decides whether a
  swap may auto-apply. Recommendations must always carry the gate's reasons.
- `recommendations.jsonl` is append-only; status changes are appended as new
  lines with the same `id` (latest line wins).
- `model_search/` (Python) is the reference implementation for the trial
  loop; `benchmark/` holds real benchmark data. Keep them working; port
  improvements back into `src/` rather than rewriting them.
- When changing state-file layouts or the policy schema, update README.md's
  state table and `instructions/openmerit.policy.json` together.
