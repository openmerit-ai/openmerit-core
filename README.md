# OpenMerit

OpenMerit is an open-source intelligence control plane for autonomous agents. It connects agent harnesses, production signals and scores, and inference infrastructure without sitting in the production inference path.

The website is a standalone local Next.js project. It has no ChatGPT Sites configuration or hosting dependency.

This repository is being rebuilt from the [OpenMerit v1 product specification](./OpenMerit-v1-product-spec.md). The current implementation is the new Next.js landing page.

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the site.

## Validation

```bash
npm run typecheck
npm run build
```
