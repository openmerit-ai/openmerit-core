# Application and agent workflows

OpenMerit does not own application execution. It benchmarks whatever task the
harness supplies and returns a structured action for the harness to interpret.
The harness keeps its invocation purpose, context, and `applyMode` locally so
the resulting action is applied to the intended application or session.
`applyMode` is harness-owned metadata: `session` permits a session route
switch, `application` asks the harness to update the product workflow, and
`ask_user` prevents an automatic mutation.

## Direct inference

Use `mode: "inference"` when the task is a single model request such as
classification, extraction, or summarization. The adapter's `runInference`
method should call the harness's normal provider abstraction and return the
same normalized response shape used for the baseline.

## Agent workflow

Use the default `mode: "agent"` when the task needs tools, multiple model turns,
or file changes. The adapter runs the candidate in an isolated temporary
workspace with an explicit tool policy and returns the final answer plus trace
and side-effect summary. Tool access is disabled unless the user explicitly
allows it for trials.

## Credential and route cascade

When benchmarking alternatives for an application or task, the harness should
evaluate availability using a multi-tier cascade to minimize user friction:

1. **Native Provider Credentials**: If direct credentials (e.g. `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`) exist in the environment or credential store, use the direct
   native route for lowest latency and native feature parity.
2. **Unified Gateway (OpenRouter)**: When native credentials for a candidate model
   are not configured, check whether a unified provider like OpenRouter is authenticated.
   If so, route the candidate through OpenRouter with zero user intervention.
3. **User Prompt (Last Resort)**: If a promising candidate route has neither native
   credentials nor a configured gateway, the harness may prompt the user or skip the route.

When rewriting application code to use a newly selected model, an OpenAI-compatible
client can often be repointed to OpenRouter's endpoint with no new SDK dependencies.

## Product workflow

When a harness is helping build or exercise a product whose own code invokes an LLM,
the harness decides how to run that product. OpenMerit supplies the selected
route and the `harnessAction` instruction; the harness can inspect the project, update
configuration or code, validate the workflow, and create a patch or PR.

After the recommendation is accepted, the harness consumes the recommendation's
`harnessAction` instruction. It owns the durable change: it can update an
environment or configuration value, run validation, and create a patch or PR.
The comparison engine remains unchanged when the product uses a different
framework or provider.

OpenMerit does not edit arbitrary source files, choose a product framework, or
assume that changing a model means changing code. If the product needs a
configuration patch, the harness can prepare that patch and later create a PR
when the user accepts the recommendation. A future harness can implement the
same contract using its own sandbox, trace format, and deployment workflow.

A useful application result includes:

- the final structured output or answer;
- validation status and domain-level quality signals;
- tool calls, tool errors, and relevant trace identifiers;
- changed files or other side effects;
- measured latency and provider usage.

Keep credentials and production writes outside candidate runs. Candidate
evidence is for model selection, not an automatic authorization to deploy.
