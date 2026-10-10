# Changelog

## 0.1.6-preview.5 — 2026-10-10

- Open the terminal before initial collection, then index repository declarations in a background worker with visible discovery, indexing, and linking progress. Replace repository-wide scan caps with continuing work batches.
- Reuse unchanged source/configuration metadata across scans, re-resolve changed dotenv bindings, and remove deleted declarations. Keep activity collection independent and disclose skipped files or interrupted indexing.
- Reuse unchanged reference catalogs in the browser and report complete issue counts alongside the bounded detail list. Request-history and runtime inventory limits are unchanged.
- Preserve ordinary function names containing `task_` instead of mistaking their suffix for a credential prefix.

## 0.1.6-preview.4 — 2026-10-10

- Index supported application code, nested configuration, custom endpoints, and conservative model/call-site references automatically during `openmerit dash`, with file-and-line evidence.
- Separate static declarations, aliases, examples, benchmarks, candidates, fallbacks, and unresolved references from recorded inference usage. Retain custom service identities without guessing vendors or hardware.
- Add a searchable code/configuration view, coverage notes, and a counts-only `openmerit dash --diagnostics` report for troubleshooting without repository access.

## 0.1.6-preview.3 — 2026-10-10

- Expand passive project endpoint discovery to 39 service identities across model APIs, inference clouds, managed cloud endpoints, and gateways; share classification with the service inventory and preserve unknown/custom endpoint boundaries.

- Recognize project-declared Hugging Face dedicated endpoints and the inference router as separate services, without cloud calls or token-based inference assumptions.

- Detect changed JSONL checkpoints before resuming incremental reads, including same-inode truncation followed by growth between polls.
- Disclose conflicting completed/failed outcomes when reconciling copies of a request.
- Prefer fresh model residency over stale reports from other exported hosts.
- Preserve unavailable usage in model details when no request source is connected.

## 0.1.6-preview.2 — 2026-10-09

- Require selected-project declarations for service and runtime discovery; remove unconditional Ollama/standard-port probes and inherited shell service detection.
- Keep endpoint identity separate from physical placement. A loopback URL does not prove that inference runs on this machine; local compute requires explicit host links.
- Retain OpenMerit task summaries separately from request counts, models, tokens, and spend.
- Preserve unknown request status, currency, and cost basis. Missing activity evidence no longer appears as measured zero usage or failures.
- Disclose bounded inventory omissions and partial source coverage.

## 0.1.6-preview.1 — 2026-10-09

- Retain historical application requests beyond 24 hours; add 7d, 30d, and default All time with calendar labels, available-history dates, and explicit partial-coverage disclosure. Existing source/read limits still apply.

## 0.1.6-preview.0 — 2026-10-09

A test prerelease of the existing `openmerit` npm package, installed with `npm install -g openmerit@preview`. Includes the compiled Inference Terminal, automatic browser opening, and a free loopback-port fallback. `latest` remains `0.1.5`.

- Add the Inference Terminal: `openmerit dash` serves a local, read-only view of models, request metadata, connections, capacity, and compute, sampled every 10–30 seconds. Agent and task identities come from supplied metadata; the terminal does not intercept inference or discover every call automatically.
- Bind task profiles, metrics, assessments, frontier artifacts, swaps, and
  automation signals to a confirmed application LLM target; Pi's own model
  telemetry cannot satisfy application evidence or become a swap target.
- Make Pi's automatic setup conditional on bounded source detection of an
  application LLM call. Projects without a detected target remain idle until
  `/openmerit setup` is requested.

## 0.1.5 — 2026-09-23

OpenMerit now ships as one npm package with a Pi extension, a reusable
coordinator, and a harness-neutral protocol.

### Changed

- Pi issues typed, bounded work to the coding harness and checks structured
  results and durable evidence before advancing the model-improvement lifecycle.
- Project state, audit events, and evidence manifests live under `.openmerit/`
  in the product repository.
- Baseline assessment, candidate trials, frontier verification, supervised
  swaps, post-swap verification, and rollback follow a confirmed project policy.
- The package exposes `openmerit/core`, `openmerit/protocol`, and `openmerit/pi`.
- Node.js 22.19 or newer and Pi 0.87 are required for the Pi integration.

### Removed from the 0.1.4 package

- The background watcher, direct provider clients, standalone CLI, and
  session-bound route comparison flow.
- Automatic use of the earlier home-directory state. The new project-local
  state starts with a confirmed task profile and leaves older files untouched.

See [the README](README.md) for installation and the current command surface.
