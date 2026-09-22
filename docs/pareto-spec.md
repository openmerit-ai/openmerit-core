# OpenMerit Pareto conformance specification

Status: initial normative specification

OpenMerit owns this definition. A connected harness performs the calculation, returns a `FrontierSnapshot`, and supplies calculation evidence. OpenMerit verifies the returned result against these rules.

## Comparable assessment set

Every assessment in one frontier calculation must share:

- task-profile ID and revision;
- product revision;
- harness identity and materially equivalent tool configuration;
- objective definitions, units, and directions;
- a representative evaluation workload and compatible evidence window.

The harness must not silently compare measurements from incompatible conditions.

## Metric readiness

A required objective is ready only when:

- a metric record exists;
- its state is `measured`;
- it has a numeric value;
- its sample count meets the objective's minimum;
- its unit and direction are compatible across candidates.

Missing or immature evidence is `unresolved`. It is never converted to zero and never treated as success.

## Feasibility

Hard constraints are evaluated conservatively against uncertainty intervals. If an interval is absent, the point value is both bounds.

- `at_least`: eligible only when the lower bound meets the threshold; ineligible when the upper bound is below it; otherwise unresolved.
- `at_most`: eligible only when the upper bound meets the threshold; ineligible when the lower bound exceeds it; otherwise unresolved.

Only eligible candidates may be certified as members of the frontier.

## Dominance

For candidate A to dominate candidate B, A must be proven no worse than B on every objective and proven materially better on at least one objective.

For a maximize objective with tolerance `t`:

- A is proven no worse when `A.lower + t >= B.upper`.
- A is proven materially better when `A.lower > B.upper + t`.

For a minimize objective with tolerance `t`:

- A is proven no worse when `A.upper <= B.lower + t`.
- A is proven materially better when `A.upper + t < B.lower`.

If complete evidence proves A worse on any objective, A does not dominate B. If the evidence cannot establish no-worse or worse because intervals overlap, the comparison is unresolved.

## Frontier

An eligible candidate is on the certified frontier when:

- no eligible candidate is proven to dominate it; and
- none of its required pairwise comparisons is unresolved.

Candidates with incomplete evidence, unresolved constraints, or unresolved comparisons are reported separately. A dominated, ineligible, or unresolved candidate must not appear on the certified frontier.

## Required result evidence

Every frontier result must include:

- the assessment IDs used;
- all directed pairwise comparisons between eligible candidates;
- reasons for every comparison;
- separate frontier, dominated, ineligible, and unresolved sets;
- at least one durable calculation-evidence reference.

The calculation evidence should identify the harness execution or artifact that produced the result.

