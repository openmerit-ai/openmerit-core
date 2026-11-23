# Amp orbs

`.agents/setup` installs Node.js 22.19.0 (the CI version) into `~/.local/bin` and runs `npm ci` at the repository root (the website), in `openmerit-core/` (the `openmerit` npm package), in `playground/` and in `cloud/` (the cloud app behind openmerit.ai/mcp), each with its own lockfile; `.agents/resume` checks they are still installed. Rerun `.agents/setup` after changing a lockfile. The project declares no orb services.

Setup also installs Docker's buildx plugin, which the cloud app's deploy uses to build its image. The Docker daemon cannot be part of the snapshot, so start it before a cloud deploy with `amp orb service start docker --command 'sudo -n dockerd --group user'` (the `--group` gives the orb user the socket) and check it with `docker info`; stop it afterwards with `amp orb service stop docker`.

`openmerit.ai` is the primary domain; `openmerit.site` hosts only legacy redirects. Use `.ai` in new links and copy; `docs/site-domain-migration.md` describes the routing.

Orbs receive a project-wide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for Wrangler. The token also reaches other projects in the same Cloudflare account: never change the `docex.dev` zone or any Worker outside the OpenMerit configurations in this repository. Read-only commands are fine; deploys and DNS, route, or email changes need the user's explicit approval each time. Deploy only through `npm run deploy -- <worker>` (the cloud app: `npm run deploy --prefix cloud`, see `cloud/README.md`) and roll back as described in `docs/site-deployment.md`; `npm run deploy:status` is read-only. Load the `deploying-openmerit-workers` skill before any deploy, rollback or secret change; `.agents/skills/README.md` lists the project skills.

Orbs also receive an `NPM_TOKEN` project secret limited to the `openmerit` package, which is published from `openmerit-core/`; `.agents/setup` points `~/.npmrc` at it. `npm publish` and dist-tag changes need the user's explicit approval each time. Release with a patch bump (0.3.0 → 0.3.1) by default, including for new features; bump the minor or major version only when the user says the change warrants it.

# Verifying your work

Every check below runs against local fakes: no secret, no paid model call, no Cloudflare or npm change. Times are from a 2-CPU orb.

| Change in | While iterating | Before you finish |
|---|---|---|
| `openmerit-core/` | `npm run typecheck` (7 s), `npm run test:fast` (25 s) | `npm run check` (100 s), `npm run build` (6 s) |
| `playground/` | | `npm run check` (12 s) |
| `cloud/` | `npm run typecheck` (5 s) | `npm run check` (75 s: tests on a local Rivet engine with fake sign-in, Stripe and models) |
| website, `docs/`, `scripts/`, `demo/` | `npm run check:docs` (2 s) | `npm run verify` (15 s); `npm run check:worker-types` (18 s) after a Wrangler configuration change |
| packaging, the CLI or the daemon in `openmerit-core/` | | also `node scripts/smoke-packed.ts` (60 s): packs and installs the tarball globally, then runs connect, setup, scout, history and MCP against a local fake |
| several of these | | `npm run check:all` at the root runs every CI job (3.5 min) |

- `test:fast` skips the openmerit-core daemon test, which kills the daemon at each of six questions and waits about 13 s each time for the local Rivet engine to resume the run. It takes 90 s and is not hung.
- To drive the CLI by hand, run `node src/cli.ts` from `openmerit-core/` with `OPENMERIT_HOME` set to a temporary directory and `OPENMERIT_NO_UPDATE_CHECK=1`. Without a TTY it never prompts: `scout --json` stops at the first question, `--answer <id=value>` answers it, and setup takes `--yes`. `test/daemon.test.ts` shows a full run against a fake harness and endpoint.
- `npm run memo` serves the website and memo locally on port 45834 (no real email).

# Working unattended

- Push branches and land work through `merge-when-green` pull requests (see Landing changes) without asking. The green CI run is the approval.
- Deploys, Cloudflare secret, DNS, route or email changes, `npm publish` and dist-tag changes still need explicit approval each time. When a goal reaches one, finish, verify and land everything that does not depend on it, then stop and report the exact command to approve. Do not stop earlier to ask.
- Real model calls are allowed when the goal needs real results: `openmerit connect`, `setup` or `scout` with a real harness (it bills its plan or key, and evals bill the candidate endpoints, within Scout's per-run eval budget), and `npm run dev` and `npm run scenarios` in `playground/` (Workers AI on the account, OpenRouter). No check needs them. `npm run build:catalogue` is free but fetches public OpenRouter and Epoch data and rewrites `data/catalogue.json`, so run it only to refresh the catalogue.
- The playground's keys reach orbs as the project secrets `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `OPENROUTER_API_KEY` and `PLAYGROUND_TOKEN`. Its scripts read them from the environment, but `wrangler dev` reads Worker secrets only from `playground/.dev.vars` (gitignored), so write that file from the environment before `npm run dev`: `for v in LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY OPENROUTER_API_KEY PLAYGROUND_TOKEN; do echo "$v=${!v}"; done > .dev.vars`. Do not set `CLOUDFLARE_INCLUDE_PROCESS_ENV`, which would bind every orb secret, including the Cloudflare and npm tokens, into the local Worker.

# Landing changes

Land changes on `main` through a pull request opened with `--label merge-when-green`. `.github/workflows/merge-when-green.yml` squash-merges it once every CI job passes on its latest commit, then runs CI on `main`, which `scripts/deploy.ts` requires. GitHub auto-merge and branch protection are unavailable for this private repository on GitHub Free, so nothing blocks direct pushes; the workflow skips pull requests that are not based on `main`, so retarget and rebase stacked pull requests after their parent merges. When the label is added after CI passed, rerun CI with `gh run rerun <run-id>`.

# TypeScript

Write new first-party code, tests and tooling in TypeScript; do not add `.js`, `.mjs`, `.cjs` or `.jsx` files. `npm run check:typescript` enforces this, and explicit `any`, `@ts-expect-error`, `@ts-ignore` and `@ts-nocheck` are not allowed. Strictness lives in `tsconfig.base.json`; do not relax it per project. Migrate existing JavaScript one boundary at a time without behavior changes, following `docs/site-typescript-migration.md`. After changing a Wrangler configuration, run `npm run types:workers` and commit the result.

# Documentation maintenance

The `openmerit` package's documentation is `openmerit-core/README.md`; `docs/` holds the memo source and the website's `site-*` maintenance notes. `scripts/build-site.ts` builds the protected memo via `scripts/build-memo.mjs` and the browser scripts. Do not edit generated memo or private content files, or maintain a second copy of an article in website code.

Do not make public claims about the project's licensing or source availability until the user explicitly authorizes that positioning. Preserve the legal license file and package metadata.

When changing user-visible product behavior, update the relevant Markdown guides in the same change. This includes commands, setup, supported versions, protocol contracts, metrics, approvals, budgets, scheduling, pause, data handling, and known limitations. Check affected homepage FAQ claims against the same behavior using `docs/site-faq-maintenance.md`. Distinguish released behavior from unreleased changes; do not describe a planned capability or an unverified outcome as established behavior.

`scripts/memo.config.ts` owns protected memo metadata; its article and Markdown must never enter public assets.

Run `npm run check:docs` after documentation or policy/memo build changes. It validates Markdown links, section destinations, live-page links and memo privacy. Website changes also require the applicable checks in `npm run verify`; `openmerit-core/`, `playground/` and `cloud/` changes require `npm run check` in that directory.

Cloudflare deployment runs these builds and checks before publishing. Only memo source edits are rendered as website pages. A successful local build or GitHub CI run alone does not publish them. Follow `docs/site-deployment.md` and `docs/site-design.md` for the existing workflow.
