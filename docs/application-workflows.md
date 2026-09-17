# Application and agent workflows

OpenMerit supports two useful shapes of LLM-backed work without owning an
application's framework or provider SDK.

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

## Product workflow

Use `mode: "application"` when Pi is helping build or exercise a product whose
own code invokes an LLM. The adapter's `runApplication` method is responsible
for preparing an isolated copy, injecting the candidate route through the
product's supported configuration, executing its real wrapper, and collecting
the product result and side effects. This is how an invoice extractor, an
application classifier, or a multi-step agent can be evaluated using the
actual workflow.

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
