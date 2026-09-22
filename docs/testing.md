# Testing

## Standard verification

```sh
npm install
npm test
npm run check
npm run verify
```

Tests cover protocol contracts, lifecycle decisions, baseline sufficiency, candidate/frontier/swap sequencing, conservative Pareto verification, persistence, audit events, safe evidence identifiers, Pi commands, private intent delivery, evidence requirements, and mutation boundaries.

## Pi load smoke test

```sh
./node_modules/.bin/pi --no-session -e ./packages/pi/src/index.ts --list-models
```

This proves the real Pi runtime loads the extension and enumerates its available catalogue. It does not prove a provider can complete an end-to-end product intent.

## Evidence levels

- **Unit verified** — deterministic behavior has automated coverage.
- **Runtime smoke verified** — the actual Pi runtime loads the extension.
- **Product trial verified** — Pi creates evals and observability in a real product and completes an intent with evidence.
- **Production verified** — representative repeated runs support reliability and distribution claims.

The current repository is unit- and runtime-smoke-verified. Product and production claims require target-product evidence.

