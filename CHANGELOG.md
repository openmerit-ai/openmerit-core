# Changelog

## Unreleased

- Add `openmerit scout`, a conversation with Scout from the terminal: clarifying questions answered with `--brief` or `--skip`, then up to five models per task, cheapest first among models that reach Scout's quality bar. When you ask for the fastest or newest model, the output names that order and shows each model's time per task or release date. It uses this device's Claude Code or Pi key and limits new conversations to the endpoint IDs in `.openmerit/scout.json`.
- The installed Scout instructions for Claude Code and Pi tell the agent to relay Scout's questions to the user and to read `tasks[].models`. This needs the matching hosted Scout release, whose `scout_models` MCP tool now runs the Scout agent.

## 0.1.12 — 2026-11-03

- Replace the obsolete Pi 0.87 evaluation adapter with native Scout support for Pi 1.5.0. Share browser device approval, private client/scope/project credentials, installer lifecycle and Scout instructions with Claude Code; keep Pi's native MCP, tools, model, permissions and session ownership intact.
- Add targeted Pi setup, status, diagnostics, login, logout and removal, preserving edited files and independent credentials. Install a self-contained automatically discovered extension; updates require an explicit installer rerun and a new session. No legacy evaluation commands, scheduler, LaunchAgent or auto-update hooks remain in the Pi adapter.
- Add the logo-first Add to Pi action below Claude Code, with copy-only setup and a clipboard-denied fallback. Scout serving and npm publication remain separate releases.
- Keep the standalone evaluation CLI and core coordinator; move the prepared demo transport out of the removed Pi adapter and declare its Pi runtime dependency explicitly.

## 0.1.11 — 2026-11-01

- Refresh packaged Scout guides and include the Saga articles maintained in Markdown.
- Recognize the Claude Code instruction updater when invoked through a symbolic link, so linked hook entry points run their update checks.
- Preserve the existing CLI, Claude Code instruction-update contract, Pi integration and public exports. Scout, Saga and homepage source changes require separate website deployments; this npm release does not publish them.

## 0.1.10 — 2026-10-26

- Add default-on Claude Code background checks for compatible Scout skill/startup-rule updates, with daily checks, 15-minute failure backoff, non-blocking failure notices with the “update openmerit” fallback, manual `openmerit update`, persistent opt-out and a natural-language update instruction.
- Verify npm package integrity and read a bounded instruction bundle without executing downloaded code. Preserve edited files, credentials, MCP configuration, privacy settings and project policy; serialize maintenance and recover interrupted instruction writes.
- Disclose setup behavior, retain other Claude hooks/settings and require a new session to reliably load updated instructions. Existing installations need a one-time installer rerun after publication; incompatible releases require a reviewed manual upgrade. Hosted Scout and npm remain separate releases.
- Enable Scout setup usage/installation diagnostics by default, honoring telemetry, DNT and account-unlink opt-outs. Terminal/evaluation analytics remain opt-in; MCP prompt-content capture remains off.

## 0.1.9 — 2026-10-24

- Add opt-in coding-agent installation milestones, component/connection diagnostics and consent-gated setup/installation correlation retained across resumed approval and upgrades. Carry browser usage and unlink choices into setup; keep standalone CLI analytics default-off and MCP prompt-content capture off.
- Add bounded installation-event retries with stable delivery IDs. Report verification and remote revocation failures even when existing local command exit semantics remain successful.
- Coordinate the independently released Scout browser/device/MCP lifecycle telemetry, correct HTTP-200 logical-error accounting, and distinguish key authorization from verified installation. These are observed events, not skipped-call detection, guaranteed delivery or downstream model-execution tracking.
- Preserve existing package exports, model-decision guidance and legal metadata. Existing installations need an installer rerun; npm publication does not deploy Scout or the main website.

## 0.1.8 — 2026-10-24

- Install an owned startup rule requiring Scout before explicit or implicit application-model choices, including pretrained/local/browser models, weight downloads and SDK defaults. Keep detailed access-policy and search instructions in the skill. These instructions are guidance, not hard enforcement.
- Upgrade unchanged skill-only installations without another device approval; include rule ownership, conflict detection, interrupted-update recovery, status, diagnostics and safe removal.
- Require a new Claude Code session after setup or upgrade; reconnecting `/mcp` alone does not reload startup instructions. Pause model selection when Scout is unavailable or lacks suitable candidates rather than falling back to a remembered model.

## 0.1.7 — 2026-10-24

- Release coding-agent device sign-in, Claude Code MCP/Scout skill installation, status, diagnostics, removal and project endpoint policy on the stable `latest` channel. Setup requires browser approval; it never requests a pasted key.
- Use `openmerit@latest` in setup and installed skill commands. Scout's independently deployed button opens a prefilled Claude Desktop Code session; the user sends the prompt.
- Promote the agent-evaluation CLI, explicit scope/budget selection and corrected accounting from the preview channel. Provider billing, native permissions and unknown costs remain separate from local reservations.
- Include automatic light/dark terminal appearance and optional, default-off CLI/terminal analytics with bounded diagnostics. Do Not Track overrides opt-in; prompts, credentials, local names and raw errors are excluded.
- Preserve existing package exports and legal metadata. The hosted Scout service and website deploy independently; npm installation does not start hourly research or execute recommended models.

## 0.1.7-preview.5 — 2026-10-17

- Update packaged Scout documentation for the independently deployed matching repair: shared evidence targeting, retrieval coverage and bounded semantic consistency checks.
- Keep earlier failed acceptance and task-execution results visible; matching checks do not establish task accuracy or globally optimal recommendations.
- Preserve the package runtime, CLI commands, exports and legal metadata. Target the `preview` channel; stable `latest` remains unchanged.

## 0.1.7-preview.4 — 2026-10-17

- Update the packaged Scout guide for the independently deployed task-relevance beta, including metadata filters, existing ambiguity responses, measured-evidence preference and bounded matching.
- Document retained execution-test failures, incomplete coverage and provisional Pareto comparisons; no improvement in exact task accuracy or globally optimal membership is claimed.
- Preserve the package runtime, CLI commands, exports and legal metadata. Publish to `preview`; stable `latest` remains unchanged.

## 0.1.7-preview.3 — 2026-10-16

- Update packaged Scout API/MCP and agent-evaluation guides for the sole `/scout/` service and current request, inventory, data-handling and reliability contracts.
- Keep the hosted hourly research and matching service separate from npm installation. Hosted publication recovery, per-source freshness, bounded Decisions retries and reduced overlapping pool reads were deployed independently.
- Exclude internal website and deployment maintenance notes from the npm artifact. Keep existing commands, exports, legal metadata and stable `latest` behavior unchanged.

## Scout semantic benchmark interpretation — hosted beta, 2026-10-15

- Replace benchmark capability/name rules and family-name regexes with hourly Decisions interpretation of source definitions and methodology.
- Cache unchanged interpretations; leave unsupported or failed scopes unclassified and preserve evidence provenance.
- Keep prompt matching local to prepared benchmark metadata, with unchanged UI, prompt/specialist calls and hourly schedule. All 24 semantic benchmark cases, 107 local/live HTTP/MCP matching cases and 546 automated checks passed. npm publication remains deferred.
- Store compressed analytics payloads as gzip bytes to avoid base64 overhead on larger evidence records; retain legacy decoding and complete-record size limits.

## Scout semantic specialist matching — hosted beta, 2026-10-15

- Replace Hugging Face domain/language keyword dictionaries and partial label overlap with Decisions compatibility checks.
- Prepare and cache specialist profiles during the hourly refresh; batch only relevant compatibility checks when a prompt arrives.
- Require all applicable domain, language and fixed-label checks to pass. Preserve unknown metrics and ordinary results if specialist checking fails.
- Keep the UI unchanged. All 107 cases passed locally and through live HTTP/MCP; 526 automated tests passed. npm remains deferred.

## Scout semantic formats and SQL interpretation — hosted beta, 2026-10-15

- Remove prompt keyword scans from strict-format and structured-data interpretation; use the existing Decisions answers, including described record layouts and non-English requests.
- Recognize read-only SQL query writing and repair without requiring schema details in the task description. Keep query source distinct from executing it, its result format, prose explanation and data modification.
- Keep uncertain format answers visible and exclude them from narrow calibration matching. Preserve response validation, general consistency checks, confidence thresholds, one interpretation request, hourly collection and the UI.
- All 91 semantic cases passed locally and through live HTTP/MCP, including the previously failing SQL request and four fresh SQL holdouts. All 511 automated tests passed. npm publication remains deferred.

## Scout category and content interpretation — hosted beta, 2026-10-15

- Recognize conversationally supplied categories without requiring a formal label list; keep subtype and individual-identity discovery open-ended.
- Require document understanding for requested written/table content, including mixed outputs, without inferring it merely from a photographed object.
- Update two existing semantic questions with unchanged confidence thresholds, UI, hourly refresh and request count. Local and live HTTP/MCP acceptance passed 43 cases; an opt-in semantic audit preserves those cases for future interpretation changes. npm publication remains deferred.

## Scout task interpretation and ambiguous matching — hosted beta, 2026-10-15

- Frame every task description as quoted data for requirement analysis, preserving supplied-label and negation semantics without prompt-specific exceptions or lower confidence thresholds.
- Keep decision-plus-prose or extraction requests on generative endpoints, reject narrow calibration for uncertain operations/outputs, and ignore weak document-layout guesses for ordinary photos.
- All 25 routing cases passed locally and through live HTTP/MCP, including the prior binary-label failure. UI, hourly refresh and the single interpretation request are unchanged. npm publication remains deferred.

## Scout identification matching — hosted beta, 2026-10-15

- Distinguish open identification from supplied-label classification within the existing interpretation call. Open or uncertain identification uses evidence-ranked generative endpoints; fixed-choice APIs and label-dependent classifiers require supplied choices.
- Require relevant visual benchmark evidence for visual requests, preserve classification label scope in calibration matching, and use ordinary output-length estimates for generated names. UI and hourly refresh are unchanged; no npm release is included.

## Scout hosted beta — 2026-10-15

- Apply shared modality, output-format, tool and operation requirements across Scout recommendation paths. Catalogue refresh now retains explicit text-output contracts and excludes mixed media output from general text candidates.
- Preserve unknown and partial token prices as `null`; keep genuine advertised zero rates distinct.
- Suppress separate specialist discovery for endpoint-scoped requests, including empty inventories.
- Honor latency priority when choosing a model's endpoint, using only timing tied to that route. UI, hourly scheduling and interpretation calls are unchanged. These four service corrections were deployed separately from npm.

## 0.1.7-preview.2 — 2026-10-15

- Ask for a $10, custom or no-fixed-cap evaluation budget after model scope; save the explicit choice, handle reservations internally, and preserve cumulative usage across reruns and budget changes. Add `eval plan --budget <USD|unlimited>` for coding agents and noninteractive setup.
- Separate native budget and environment blocks from task scores in agent evaluations; probe the Codex Linux sandbox before making model requests.
- Recover partial Claude usage, retain partial cost estimates, keep missing native pricing unknown, and preserve budget reservations independently of estimated charges. Report version 2 separates these accounting rules from earlier comparisons.

## 0.1.7-preview.1 — 2026-10-15

- Add `openmerit eval init/doctor/plan/run/watch/report`: Scout shortlists, explicit model scope, Claude Code/Codex/OpenCode adapters, fresh task attempts, local graders, balanced adaptive 3–10 repetitions, revision comparisons and cumulative budget accounting.
- Bundle project agent instructions without install-time hooks. Missing usage/cost remains unknown and partial comparisons are disclosed. Terminal/Pi behavior is unchanged.
- Use the hosted Scout HTTP/MCP `modelIds` filter to select eligible candidates before ranking. This API change was deployed separately on 15 October 2026.

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
