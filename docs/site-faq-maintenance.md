# Website FAQ maintenance

The public FAQ lives in `site/index.html`. Its answers describe the published package, including known limitations, rather than planned capabilities or unreleased fixes.

Last factual review: 2026-09-23, against npm `openmerit@0.1.5`, the Pi 0.87 adapter, and the current source. The FAQ contains 13 questions. The earlier audit reproduced a task-triggered assessment while `/openmerit status` reported paused and confirmed the same dispatch path in the published package.

Source review on 2026-09-27: unreleased post-build target detection, harness-inferred user-confirmed metric sampling plans, incumbent and comparison handoffs, setup-time model leads, deterministic core baseline-window checks, macOS Pi LaunchAgent provisioning, and durable pause are under development. The homepage intentionally continues to describe published npm `openmerit@0.1.5`; update it only when a release containing those changes is published and verified.

The experimental `npm run demo` sandbox is a repository-local live-provider demonstration, not a released package workflow. Its end-to-end result and tiny pilot sample do not change the homepage's shipping-behavior or reliability claims.

## Sources to review when behavior changes

| FAQ anchor | Claims to verify | Primary sources |
| --- | --- | --- |
| `faq-agent` | Harness responsibility; limits of result validation | `packages/pi/src/index.ts` (`privateIntentMessage`), `packages/core/src/index.ts` (`interpretIntentResult`), `docs/architecture.md` |
| `faq-harnesses` | Implemented adapters; supported Pi versions | `packages/`, root `package.json` peer dependencies, `docs/adapter-guide.md` |
| `faq-evaluations` | Interactive setup; task-specific instrumentation | Pi `session_start`, core `establish_evals` outcome and observability validation, `docs/getting-started.md` |
| `faq-comparisons` | User objectives; candidate tradeoffs; no promised savings | Core `verifyFrontierSnapshot`, `docs/pareto-spec.md` |
| `faq-evidence` | Required samples; unresolved candidates; evidence trust | Core feasibility and frontier verification, `docs/metrics-and-evidence.md`, `docs/security.md` |
| `faq-approval` | Opt-in automation; zero-capable graduation threshold; post-swap evaluation | Core `nextImprovementAction`, `packages/protocol/src/schemas.ts` (`SupervisedGraduationPolicySchema`), Pi `approve` command |
| `faq-regressions` | Post-swap regression handling; conditional rollback | Core `interpretIntentResult` and `nextImprovementAction`, `docs/lifecycle.md` |
| `faq-background` | Active-session signals; no built-in persistent scheduler | Pi `PI_HARNESS_DESCRIPTOR`, core `buildAutomationPlan`, `docs/automation.md` |
| `faq-pause` | Which automatic dispatches stop; restart behavior; active work | Pi `reportAutomationSignal`, `createInitialUiState`, completion handler and `pause` command; `docs/operations.md` |
| `faq-data` | Project files; Pi session entries; harness/provider data flows | `packages/core/src/store.ts`, Pi `appendEntry` and `privateIntentMessage`, `docs/security.md` |
| `faq-cost` | License; npm availability; provider and infrastructure costs | `LICENSE`, published npm metadata, harness execution path |
| `faq-budget` | Budget passed to harness; absence or presence of metering/cutoffs | Core `createOpenMeritIntent`, budget consumers across `packages/` |
| `faq-readiness` | Implemented, tested, and product-validated behavior | `docs/testing.md`, `docs/roadmap.md`, actual product-trial evidence |

## Review during releases and website updates

1. Check the current published npm version and compare its behavior with the answers above. Keep unreleased behavior clearly labeled; update version-specific caveats only when the relevant release is available.
2. Review affected answers whenever adapters, setup, evidence checks, approval, rollback, scheduling, pause, storage, budget handling, or readiness change. Read implementation and meaningful test evidence before strengthening a claim.
3. Keep the linked operational documentation consistent. In particular, a pause fix needs coverage for task signals, measurement signals, session-start signals, lifecycle follow-ups, and restart behavior before the FAQ can promise a complete pause.
4. Check the expanded disclosures at desktop and narrow mobile widths, including keyboard operation, links, and JavaScript-disabled reading. Verify the served FAQ after publishing.
5. Record the reviewed version, date, and any remaining limits here.

## Wording boundaries

- Separate issuing a request from the harness successfully executing it.
- Distinguish structured-result and comparison validation from independent proof that evidence is authentic.
- Describe a budget as a harness constraint until metering and spending cutoffs exist.
- Describe verification as post-swap evaluation, not a guarantee that a change is safe before it is applied.
- Claim local storage only for the relevant OpenMerit files; account for Pi session history and configured external systems.
- Keep ordinary coding checkpoints distinct from task-specific product measurements.

## Inference Terminal — unreleased source, 7 October 2026

Reviewed the homepage evidence, background, data, cost, and readiness claims against the new terminal. It reads existing project metadata and loopback runtime inventory on a bounded interval and samples whole-machine CPU/memory. It makes no inference calls, routes no traffic, runs no evaluations, and stops collecting when its CLI exits. Sample data is labeled and separate. Credential-variable detection reveals provider names only; it never uses credentials for provider calls.

Deployments, reported path hops, shared pools, additional hosts, sites, and racks come from explicit configuration or bounded exports. Source timestamps determine freshness. Agent/task names come only from recorded metadata; source code alone does not establish execution. Full local hostnames are system-reported. Missing identities and readings remain explicit. No network discovery, model verification, routing enforcement, available-headroom guarantee, or per-agent resource attribution is implied.

Top navigation, shared dropdowns, model/service images, path colors, chart interactions, and denser source rows change presentation only. Images and animation libraries are bundled locally. This remains an unreleased command; published package behavior and homepage FAQ claims are unchanged. No homepage wording changes are needed before release.

## Hosted terminal sample — 7 October 2026

The separate `dash.openmerit.site` preview serves generated fictional data and terminal assets only. It has no collector, filesystem access, provider credentials, inference endpoint, upload path, or connection to a visitor's local environment. Public access is by link; noindex is a search-engine request, not authentication. The root site's FAQ and published npm claims remain unchanged. The deployment uses its own Worker and exact custom domain, and does not redeploy the main site or its demo/memo services.

The hosted preview’s dedicated sharing card and `Inference Terminal by OpenMerit` title change presentation only. Its social description still identifies the environment as fictional; homepage FAQ and package claims are unchanged.

## Inference service identity — unreleased source, 8 October 2026

Baseten and Cerebras credential-name detection joins Groq and the existing services. Known HTTPS endpoint overrides identify configuration independently of SDK vendor; unknown overrides suppress credential-name attribution. Only inherited variables are checked, and no credential values or raw URLs reach the snapshot. No cloud calls, account access, source-code scanning, `.env` loading, or physical hardware inference is introduced. Model creators, deployment modes, and accelerator vendor/kind come from explicit metadata. Configured services remain distinct from observed requests. The hosted sample uses fictional examples; package and homepage claims remain unchanged.
