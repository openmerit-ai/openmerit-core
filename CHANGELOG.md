# Changelog

## Unreleased

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
