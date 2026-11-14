# OpenMerit

OpenMerit finds the right model for your task from measured results on your own labelled examples. This repository holds:

- **[`openmerit-core/`](openmerit-core/README.md)**: the `openmerit` npm package, a local CLI and MCP server. Scout runs in a local daemon, finds cheaper ECI-ranked models that do at least as well as the ones your code uses, measured with your repository's own evals, and reads per-item results back from Langfuse or the eval's own report. It has its own lockfile, tests and build.
- **[`playground/`](playground/README.md)**: Sahra Health, a fictional customer project that uses the published `openmerit` package. It has its own lockfile and checks.
- **The openmerit.ai website**: the landing page (`site/index.html`), the protected memo (`docs/memo-published.md`, served by `demo/site.ts`) and the Clerk sign-in at `/scout/` (`site/scout/`, served by `demo/web.ts`). `demo/domain-router.mjs` routes the public hosts between them.

## Commands

```sh
npm ci && npm run verify                           # website: typecheck, tests, memo and docs checks, build
(cd openmerit-core && npm ci && npm run check)     # the npm package
(cd playground && npm ci && npm run check)         # the customer playground
```

Deployment and rollback of the website Workers are in [docs/site-deployment.md](docs/site-deployment.md). The memo is described in [docs/site-memo.md](docs/site-memo.md).
