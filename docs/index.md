# OpenMerit documentation

OpenMerit helps your coding harness compare models against the work your product needs to do. You define what matters; the harness gathers measurements and tests candidates; OpenMerit coordinates the process and checks the returned results.

The current release is intended for supervised trials with Pi. Start with a representative task and working evaluations before relying on automatic model changes.

## Start with your product

Install the extension in Pi, then open your product repository:

```sh
pi install npm:openmerit
```

Interactive setup asks Pi to establish your task requirements, evaluation budget, automation permissions, and measurements. Follow the [getting started guide](getting-started.md), then work through a [first supervised trial](first-trial.md).

## Understand the decisions

OpenMerit compares candidates against the objectives you confirm, such as quality, cost, and latency. Several models may offer useful tradeoffs. A cheaper model is not automatically a better fit.

- [Metrics and evidence](metrics-and-evidence.md) explains which measurements and samples a comparison needs.
- [Comparisons and swaps](lifecycle.md) follows a baseline through challenger trials, approval, and post-swap checks.
- [Budgets and permissions](budgets.md) describes the limits you give the harness and where enforcement depends on it.
- [Automatic checks](automation.md) explains when work becomes due and what needs an external scheduler.

## Operate with visibility

Use [commands](commands.md) to inspect status and request work. [Project files and logs](operations.md) explains what is stored, and [troubleshooting](troubleshooting.md) covers common setup and evidence problems.

OpenMerit checks structured results and model comparisons. It relies on the harness to execute the work and provide honest evidence. Read the [security notes](security.md) and [current limitations](roadmap.md) before enabling automation.

## Build an integration

Pi 0.87 is the only implemented adapter today. The core and protocol can support other harnesses through an adapter.

Start with the [architecture](architecture.md), then the [adapter guide](adapter-guide.md). The [Pareto specification](pareto-spec.md) defines the comparison rules, and [testing and validation](testing.md) explains the evidence behind implementation claims.
