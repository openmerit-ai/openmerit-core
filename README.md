# OpenMerit

OpenMerit finds cheaper models that pass an eval written from your code, and stays out of your live request path. It is free to run on your machine; [OpenMerit Cloud](https://openmerit.ai/contact-sales/) runs it for you. Website: **[openmerit.ai](https://openmerit.ai)**.

This repository holds:

- **[`openmerit-core/`](openmerit-core/README.md)**: the `openmerit` npm package: the OpenMerit server (`src/server`, the same server openmerit.ai runs and `openmerit server start` runs locally), the search engine and ranking it uses, and the CLI and `openmerit mcp`, which are clients of a server. It has its own lockfile, tests and build.
- **[`playground/`](playground/README.md)**: Sahra Health, a fictional customer project that uses the published `openmerit` package. It has its own lockfile and checks.
- **The openmerit.ai website**: the landing page (`site/index.html`), the protected memo (`docs/memo-published.md`, served by `demo/site.ts`) and the buyer-question and contact-sales pages, served by `demo/web.ts`, which redirects the retired `/scout/` to `/contact-sales/`. `demo/domain-router.mjs` routes the public hosts between them.

## Commands

```sh
npm ci && npm run verify                           # website: typecheck, tests, memo and docs checks, build
(cd openmerit-core && npm ci && npm run check)     # the npm package
(cd openmerit-core && npm run test:server)         # the server it ships, hosted at openmerit.ai
(cd playground && npm ci && npm run check)         # the customer playground
```

Deployment and rollback of the website Workers are in [docs/site-deployment.md](docs/site-deployment.md). The memo is described in [docs/site-memo.md](docs/site-memo.md).
