# Benchmark TypeScript conventions

All benchmark runners execute directly on Node 22.18+. They are type-checked
together by `benchmark/tsconfig.json` and intentionally emit no JavaScript.

## Compatibility rules

- Use ESM and explicit `.ts` extensions for imports between benchmark files.
- Keep syntax compatible with `erasableSyntaxOnly`; avoid enums, namespaces,
  parameter properties, and other constructs that require TypeScript code
  generation.
- Preserve request bodies, retry rules, scoring semantics, output field names,
  timestamped artifact names, and overwrite guards.
- Keep paid runs opt-in through `OPENROUTER_API_KEY`. Verification and audit
  paths must remain offline except for commands explicitly checking current
  model availability.
- Preserve Python-compatible comparison, formatting, and compensated
  floating-point helpers where they affect historical artifact equivalence.

## Intentional representation differences

New TypeScript artifacts use JavaScript's JSON serialization and
`Date.toISOString()`: non-ASCII text remains literal UTF-8, integral JSON
numbers do not retain a trailing `.0`, and timestamps use milliseconds plus
`Z`. Parsed values and benchmark metrics are unchanged.

Runtime exception wording can differ between Node and the former implementation.
The text-to-SQL evaluator uses Node's bundled SQLite version and isolates each
generated query in a child process to retain the two-second execution limit.

The recorded invoice OCR rounds, text-to-SQL run, and policy-adjudication run
have been replayed through both implementations; their audited scores,
summaries, rankings, and Pareto layers match.
