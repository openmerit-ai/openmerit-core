# Sahra Health playground

This directory is a **customer project**. Sahra Health is a fictional, AI-native health insurer in Dubai. It uses OpenMerit the way an outside customer would, so the team can test OpenMerit releases from the customer's side.

## Treat it as a customer

- Do not read, search, import or copy OpenMerit source outside `playground/`. That includes the parent repository's `packages/`, `scout/`, `scripts/`, `docs/`, `site/` and git history. Use only what a customer has: the published `openmerit` package in `node_modules/openmerit` (including its `docs/` and `README.md`), `npx openmerit@<version> --help`, the public website, and Scout itself.
- Install `openmerit` from npm at the exact version pinned in `package.json`. Never link or install the local workspace source.
- If OpenMerit behaves unexpectedly, record it in `FINDINGS.md` as a customer would report it. Do not fix OpenMerit from here.

## Model choices go through Scout

Before choosing, changing or adding any application model (chat, extraction, embeddings, OCR, classification), consult Scout with the `openmerit-scout` skill, or `npx openmerit scout "<task>"` when no skill is loaded. Give Scout the policy in `POLICY.md`, including UAE health-data residency. Record every consultation in `MODEL-DECISIONS.md`: the task text, what Scout recommended, what was chosen, and whether residency was respected, flagged as a gap or ignored. Do not choose a model from memory or an SDK default.

## Data and safety

- Every person, member, provider, clinician, Emirates ID, claim and amount here is fictional. Never add real patient or member data. Traces go to Langfuse Cloud (US), which is not covered by a HIPAA or BAA agreement on this plan and is outside the UAE.
- Payment requires a human approval recorded through `scripts/approve.ts`. Do not add code paths that pay without it.

## Cloudflare and secrets

- Every Cloudflare resource is named with a `playground-` prefix. Do not touch any other Worker, zone or resource in the account.
- Deploys, secret changes and any other change to Cloudflare resources need the user's explicit approval each time. `wrangler dev` is fine.
- Langfuse keys come from the environment (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`). Never print them or ask for them in chat.

## Evals

The Langfuse project, the `sahra-outpatient-claims` dataset and every score name belong to Sahra. Never name them with an `om-` prefix. README.md lists the task, agent and environment scores and where each is posted; keep that table in step with `src/workflow.ts` and `scripts/run-scenarios.ts`.

## Commands

All from `playground/`, with Node.js 22.19 or newer:

```sh
npm ci                     # install exactly the lockfile
npm run check              # typecheck and deterministic tests (what CI runs)
npm run dev                # wrangler dev (Workers AI calls run on the account)
npm run scenarios          # submit the fixtures to the dev server; --model <agent>=openrouter/<id>,... per agent
npm run approve -- <claim-id> approve|reject --by <name> [--note <text>] [--run <run-id>]
```

Write TypeScript only. `README.md` describes the design; `FINDINGS.md` is the release-testing log.
