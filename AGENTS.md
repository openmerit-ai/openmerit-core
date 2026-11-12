# Amp orbs

`.agents/setup` installs Node.js 22.19.0 (the CI version) into `~/.local/bin` and runs `npm ci` for the website at the repository root. `openmerit-core/` (the `openmerit` npm package) and `playground/` have their own lockfiles; run `npm ci` in each before working there. The project declares no orb services.

`openmerit.ai` is the primary domain; `openmerit.site` hosts only legacy redirects. Use `.ai` in new links and copy; `docs/site-domain-migration.md` describes the routing.

Orbs receive a project-wide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for Wrangler. The token also reaches other projects in the same Cloudflare account: never change the `docex.dev` zone or any Worker outside the OpenMerit configurations in this repository. Read-only commands are fine; deploys and DNS, route, or email changes need the user's explicit approval each time. Deploy only through `npm run deploy -- <worker>` and roll back as described in `docs/site-deployment.md`; `npm run deploy:status` is read-only. Load the `deploying-openmerit-workers` skill before any deploy, rollback or secret change; `.agents/skills/README.md` lists the project skills.

Orbs also receive an `NPM_TOKEN` project secret limited to the `openmerit` package, which is published from `openmerit-core/`; `.agents/setup` points `~/.npmrc` at it. `npm publish` and dist-tag changes need the user's explicit approval each time. Release with a patch bump (0.3.0 → 0.3.1) by default, including for new features; bump the minor or major version only when the user says the change warrants it.

# Landing changes

Land changes on `main` through a pull request opened with `--label merge-when-green`. `.github/workflows/merge-when-green.yml` squash-merges it once every CI job passes on its latest commit, then runs CI on `main`, which `scripts/deploy.ts` requires. GitHub auto-merge and branch protection are unavailable for this private repository on GitHub Free, so nothing blocks direct pushes; the workflow skips pull requests that are not based on `main`, so retarget and rebase stacked pull requests after their parent merges. When the label is added after CI passed, rerun CI with `gh run rerun <run-id>`.

# TypeScript

Write new first-party code, tests and tooling in TypeScript; do not add `.js`, `.mjs`, `.cjs` or `.jsx` files. `npm run check:typescript` enforces this, and explicit `any`, `@ts-expect-error`, `@ts-ignore` and `@ts-nocheck` are not allowed. Strictness lives in `tsconfig.base.json`; do not relax it per project. Migrate existing JavaScript one boundary at a time without behavior changes, following `docs/site-typescript-migration.md`. After changing a Wrangler configuration, run `npm run types:workers` and commit the result.

# Documentation maintenance

The `openmerit` package's documentation is `openmerit-core/README.md`; `docs/` holds the memo source and the website's `site-*` maintenance notes. `scripts/build-site.ts` builds the protected memo via `scripts/build-memo.mjs` and the browser scripts. Do not edit generated memo or private content files, or maintain a second copy of an article in website code.

Do not make public claims about the project's licensing or source availability until the user explicitly authorizes that positioning. Preserve the legal license file and package metadata.

When changing user-visible product behavior, update the relevant Markdown guides in the same change. This includes commands, setup, supported versions, protocol contracts, metrics, approvals, budgets, scheduling, pause, data handling, and known limitations. Check affected homepage FAQ claims against the same behavior using `docs/site-faq-maintenance.md`. Distinguish released behavior from unreleased changes; do not describe a planned capability or an unverified outcome as established behavior.

`scripts/memo.config.ts` owns protected memo metadata; its article and Markdown must never enter public assets.

Run `npm run check:docs` after documentation or policy/memo build changes. It validates Markdown links, section destinations, live-page links and memo privacy. Website changes also require the applicable checks in `npm run verify`; `openmerit-core/` and `playground/` changes require `npm run check` in that directory.

Cloudflare deployment runs these builds and checks before publishing. Only memo source edits are rendered as website pages. A successful local build or GitHub CI run alone does not publish them. Follow `docs/site-deployment.md` and `docs/site-design.md` for the existing workflow.
