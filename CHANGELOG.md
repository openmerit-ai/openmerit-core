# Changelog

All notable changes to OpenMerit are documented here.

## 0.1.5 — 2026-09-17

### Changed

- Made the Pi-triggered, session-bound comparison loop the only runtime
  decision path.
- Preserved exact provider routes throughout selection, execution, evaluation,
  recommendations, and application.
- Routed evaluation through Pi's configured model registry and credential
  store instead of OpenMerit-owned provider clients.
- Replaced LLM shortlist generation with deterministic, auditable price-spread
  selection across policy-eligible harness routes.
- Added policy v3 with `comparison.max_routes` and `evaluator_model`.
- Revalidated current policy, task, session, and baseline route immediately
  before automatic application.
- Revalidated exact fallback routes against current provider and price policy
  before automatic error recovery.
- Added process-locked spend accounting and conservative per-trial admission
  estimates.
- Made `fallback.auto_update` authoritative when an applied decision would
  replace the persisted fallback.

### Removed

- The background watcher, trace crawler, catalog queue, and session-unbound
  recommendation path.
- Direct OpenRouter, OpenAI, and Gemini clients and credential loading.
- Dynamic provider/model injection and the public standalone trial command.
- Runtime invoice-specific evaluation behavior and packaged benchmark data.

### Compatibility

- Existing trial and recommendation evidence remains readable.
- `watch.models_per_task` migrates to `comparison.max_routes` when loaded.
- `judge_model` migrates to `evaluator_model` when loaded.
- Obsolete state files are left untouched and are no longer read or written.

See [the 0.1.5 architecture decision record](docs/0.1.5-architecture-decisions.md)
for the reasoning and product boundary behind these changes.
