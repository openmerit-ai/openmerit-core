# Demos and samples

## Explore the terminal

- [Hosted enterprise sample](https://dash.openmerit.ai/): 200 fictional agents, 699 task IDs, 21 models, and 9.6 million requests across 30 days. It demonstrates inventory, paths, activity, shared compute, and source coverage without reading your machine.
- [Before/after comparison](https://dash.openmerit.ai/demo): fourteen fictional insurance workflows and six preference choices across 26 model/service offers. Workloads and token volume stay fixed; costs are modeled from the dated price catalog. Benchmark and efficiency exceptions remain visible as preference overrides.

Neither hosted terminal example makes inference calls, applies model changes, or establishes application quality or latency. See [the comparison methodology](inference-terminal.md#hosted-enterprise-sample-and-comparison) for the exact selection rules, costs, and evidence limits.

## Interactive website experiment

The separately deployed [delivery-resolution experiment](https://openmerit.ai/demo/) uses fictional customer cases and bounded live provider calls. Its [guide](interactive-demo.md) explains the current scenarios, approval and verification steps, and session limits. This is distinct from the passive dashboard samples above.

## Run your own supervised trial

Use [Pi setup](getting-started.md#set-up-model-comparisons-with-pi) and [your first trial](first-trial.md) for real application measurements. The repository's separate `npm run demo` sandbox makes live provider calls; its requirements and spend boundaries are in [testing](testing.md#experimental-sandbox).

## Recorded player

Main also retains a recorded player in `site/demo/`, served at `/demo` by this checkout's static preview. Its September 28, 2026 recordings and the walkthroughs below document specific earlier experiments. They are not a description of the separately deployed interactive website demo, current provider availability, or a new validation of main. Existing recording links remain available for inspecting their evidence.

## Recorded examples in this checkout

| Scope | Demo | How it is structured |
| --- | --- | --- |
| Tasks | [Support tickets](demo-support.md) | One model call turns an email into a ticket; three models face the same exact-match checks. |
| Tasks | [Spam filter · Jev](demo-spam.md) | A chat model and a typed-decision specialist classify comments under the same promotional-spam policy. |
| Agents | [Backfill recovery](demo-backfill.md) | Three dependent turns inspect an incident, read a checkpoint, and prepare a recovery manifest. |
| Agents | [GPU placement](demo-placement.md) | Three dependent turns read requirements, inspect capacity, and choose a pool under six constraints. |
| Agents | [Field kit · Six tasks](demo-fieldkit.md) | A prepared six-model workflow translates, reads an image, extracts HTML, inspects code, checks feasibility, and writes a handoff. Both paths use six distinct models. |

## How a comparison works

Every recorded comparison uses a prepared application, synthetic fixtures, a grading rubric, instrumentation, API adapters, and a bounded model shortlist. Both application paths receive the same inputs and task rules. The **without OpenMerit** path keeps its original configuration. The managed path follows this sequence:

1. **Measure a baseline.** Pi runs the incumbent on the fixed evaluation suite and saves outputs, costs, latency, and grading results.
2. **Compare challengers.** The same suite measures alternative models or complete model routes. OpenMerit checks the returned evidence references, result contracts, and frontier conformance. A cheap candidate that fails a requirement cannot qualify.
3. **Request approval.** The prepared demo policy proposes the lowest observed cost among eligible frontier candidates only when it is below the incumbent cost. Keeping the incumbent is a valid outcome.
4. **Apply and verify.** After operator approval, Pi changes the application's configuration and checks it on separate inputs. The confirmed policy requests restoration of the incumbent if verification fails.

The agent examples compare supplied route configurations as whole workflows. They do not search all possible per-task model assignments. Pi's orchestration model stays fixed. The adapters, fixtures, and helpers are prepared in advance; OpenMerit does not generate those integrations in these demos.

Pi invokes bounded helpers and submits saved artifacts by name through a demo-specific transport bridge. The bridge expands those references into the adapter's canonical results and signals. The actual OpenMerit lifecycle then validates and advances the comparison. Missing provider cost stops a comparison instead of being treated as zero; a partial run is not a successful outcome.

The repository runner supplies explicit sampling plans, metric aggregations, and an incumbent descriptor to match the current protocol. Candidate limits count the incumbent and challengers together. Its comparison manifest records the fixed fixtures, rubric, model routes, and actual run order; the incumbent's baseline is reused in the comparison and included in evaluation-spend accounting. Runs are not randomized. The recordings retain their original execution evidence; the current runner does not establish a new validation result without a new run.

## Playback controls

The player in `site/demo/` is for recorded playback. It makes no model calls, starts no sandbox, and accepts no custom inputs. The **How it works** link opens the guide for the selected example.

- **Pause / Play** stops or resumes playback. Seeking on the timeline pauses at the selected position.
- **Replay** starts the recording again from the beginning.
- **Reset** returns to the beginning paused and closes Run details.
- **Run details** shows the evaluation policy, sample input and outputs, provenance, and **Download evidence**, which saves the selected recording as JSON.

Switching task or scope starts the selected recording from the beginning and closes Run details. Returning to a scope restores its last selected example. Left/Right arrows and Home/End move within each tab row. Task-specific URLs open the matching scope and example. Playback stops at the end and does not advance while the browser tab is hidden.

The available recordings were captured on September 28, 2026. Support and spam ran in Cloudflare; backfill, GPU placement, and field kit ran locally with real OpenRouter calls, as labeled in their provenance. The 36-second presentation compresses the original timing. Operator approval, outputs, and measurements are captured events, not new work performed while watching.

## Reading the results

Each example has a short description below its tabs explaining the task and intended result. It remains visible throughout playback, including when paused, completed, or reset.

The main view shows the decision, both application paths, and the run trace. A single-task demo shows one model per path; an agent recording shows each task's model. The managed assignments stay on the baseline until the recorded change is applied. Resetting or seeking backward restores the corresponding earlier state.

Quality is the number of matching fixtures or completed goals in the finite suite. Cost is the observed mean application cost multiplied by 1,000 and rounded to $0.001; it is not a separate 1,000-input test. Latency is mean end-to-end application request time, including the complete sequential workflow for agents, shown to two decimal places in seconds. Percentage changes use the original unrounded measurements, and slower outcomes are labeled as higher latency.

Application costs exclude Pi orchestration and infrastructure. GPU quotes inside a placement plan are synthetic job data, separate from measured inference costs. Evidence downloads retain original unrounded measurements and provenance; the player presents a curated recording rather than the full temporary runner filesystem.

## Scope and limitations

These examples use small synthetic suites, supplied prompts, fixed helpers, and preselected candidates. Their observed results are not production success-rate estimates, confidence bounds, or promised savings. Recovery manifests are never executed, GPU capacity is never reserved, and field-kit scripts are never run. Watching downloads static assets and recorded synthetic evidence; it sends no inputs to model providers.

For your own workload, follow [your first trial](first-trial.md). The [architecture guide](architecture.md) explains the boundary between OpenMerit and the coding harness.
