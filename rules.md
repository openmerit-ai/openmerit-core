# OpenMerit product and architecture rules

- **Be the decision layer.** OpenMerit answers which configured model route or
  route plan offers the highest expected value for this task under the user's
  current constraints.

- **Do not become the adjacent layers.** Harnesses execute agent work,
  providers supply inference, and observability systems collect operational
  telemetry. OpenMerit consumes normalized inputs from them and returns route
  decisions; it does not replace them.

- **Serve only users and their users.** No provider, reseller, benchmark owner,
  or hosted operator may influence routing through hidden commercial priority.
  Open source and auditable evidence are part of the correctness model.

- **Optimize user-defined value.** Quality, price, latency, reliability,
  privacy, locality, capacity, and other objectives remain explicit. Do not
  hide product policy inside a universal proprietary score.

- **Separate model identity from execution route.** Keep stable logical model
  IDs in `vendor/model` form and record the exact provider route independently.
  Equivalent models through different providers are different executable
  options.

- **Preserve exact routes end to end.** Discovery, admission, execution,
  evaluation, recommendation, fallback, and application must never silently
  substitute another provider.

- **Respect the harness's eligible pool.** OpenMerit may enrich or recommend
  routes, but it executes and applies only routes explicitly configured and
  available in the active harness.

- **Never own universal provider credentials.** Inference for comparisons and
  evaluation runs through an integration's credential and route system.
  Optional catalog connectors provide signals, not covert execution paths.

- **Treat public benchmarks as priors, never proof.** Merit comes from the
  user's workload and outcomes. Every prior must retain source, scope,
  timestamp, and confidence.

- **Keep the kernel integration-neutral.** Candidate execution and evaluator
  inference are explicit interfaces. Pi is the first integration and reference
  implementation, not a permanent domain assumption.

- **Make decisions reproducible and auditable.** Candidate selection, evidence
  normalization, frontier computation, and policy application must be
  deterministic for the same inputs unless exploration randomness is explicit,
  seeded, and recorded.

- **Keep policy as the only automatic-application authority.** Recheck current
  policy immediately before acting. Recommendations always retain gate reasons,
  evidence, baseline route, task identity, target session, and timestamp.

- **Prefer route plans over isolated winners.** Every production decision should
  converge on a primary plus ordered, task-qualified fallbacks, escalation
  conditions, and expiry or reevaluation rules.

- **Design for continuous change.** Price drift, latency drift, quality drift,
  outages, capacity limits, rate limits, deprecation, and new routes are normal
  state transitions—not exceptional manual maintenance.

- **Fail safely and degrade automatically.** Never claim absolute availability.
  Maintain and apply the next best acceptable route whenever one remains
  available under policy.

- **Require explicit metadata rather than guesses.** Unknown route price,
  context, output limits, or modalities must be supplied by an exact-route
  override or remain unknown. Never assume a local model is free.

- **Default comparisons to least privilege.** Candidate tools are off by
  default, provider extensions are explicit allowlists, temporary workspaces
  are cleaned, and OpenMerit never recursively launches itself.

- **Keep evidence durable and portable.** Version persisted records, evolve
  schemas additively, keep append-only decision history, and preserve old
  evidence even when obsolete execution paths are removed.

- **Keep benchmarks outside runtime behavior.** Checked-in benchmarks verify
  scorers and regressions. Product code must not special-case a benchmark,
  package its private fixtures, or mistake benchmark performance for current
  workload value.

- **Keep the core lightweight.** Integrations and signal sources remain
  optional. Users who do not enable a provider, catalog, or observability
  connector must not inherit its credentials, network calls, or dependencies.
