# TypeScript migration

All first-party JavaScript, including Workers, browser code, tests and deployment tooling, moves to strictly typechecked TypeScript. Generated and vendored output (`dist/`, `site/docs/`, `site/scout/vendor/`, terminal browser bundles) is excluded. Migration happens in stages; this note records the rules and the current state.

## Rules

- **No new JavaScript.** New files are TypeScript. `npm run check:typescript` fails for any `.js`, `.mjs`, `.cjs` or `.jsx` file that is not in [`scripts/typescript-ratchet.json`](../scripts/typescript-ratchet.json).
- **The baseline only shrinks.** After converting a file, run `npm run check:typescript -- --update` and commit the shorter list. The check fails until the converted file leaves the list, so progress cannot silently regress.
- **No suppressions.** `@ts-ignore` and `@ts-nocheck` are rejected. Explicit `any` and `@ts-expect-error` start at zero and can only fall. A `@ts-expect-error` needs a reason in the same comment.
- **Strict everywhere.** [`tsconfig.base.json`](../tsconfig.base.json) owns the flags: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` and `isolatedModules`. Runtime projects extend it; they do not relax it.
- **Erasable syntax only.** Node.js 22.19 runs `.ts` files directly by stripping types, so `erasableSyntaxOnly` forbids enums, namespaces, parameter properties and other syntax that needs code generation. Relative imports keep their `.ts` extension; the package build rewrites them.
- **Optional state fields.** Under `exactOptionalPropertyTypes`, a property that code clears by writing `undefined` (which JSON then drops) is declared `name?: T | undefined`.

## Projects

| Project | Runtime | Contents |
|---|---|---|
| `tsconfig.json` | Node.js | `packages/**/*.ts`, `scripts/**/*.ts` |
| `tsconfig.build.json` | Node.js emit | Package sources compiled into `dist/` |

Each Worker gets its own project when its first TypeScript file lands, because generated Worker types declare one global `Cloudflare.Env` per Worker. A browser project arrives with the first browser module.

## Worker binding types

`npm run types:workers` writes binding types for each Wrangler configuration into `types/cloudflare/`, using interfaces `SiteEnv`, `DomainRouterEnv`, `ScoutServingEnv`, `ScoutPublisherEnv` and `TerminalPreviewEnv`. CI's `worker-types` job runs `npm run check:worker-types` and fails when a configuration changes without regenerated types. Each `wrangler types` run takes about a minute, so it stays out of `npm run verify`.

Runtime types (about 600 KB per compatibility date) are not committed yet. They are generated for a Worker's project when that Worker migrates. Secrets are not part of the configuration, so each Worker declares its secret names next to its entry point.

## Converting a boundary

One boundary, such as a directory or a Worker, per pull request, with no behavior changes:

1. Format the files, if needed, in a separate commit.
2. `git mv` each `.mjs` to `.ts` and update imports, in a separate commit so history follows the rename.
3. Add types until `npm run typecheck` passes, then `npm run check:typescript -- --update`.
4. Run `npm run verify`. Also run the boundary's extra checks: `npm pack --dry-run` file lists for the package, `wrangler deploy --dry-run --outdir` bundles for Workers, and built-asset comparisons for browser code.

## Order

1. **Baseline (done):** strict shared configuration, ratchet, pinned Wrangler, generated binding types.
2. **Tooling and routers:** `scripts/`, `.amp/loopback-proxy.mjs`, `demo/domain-router.mjs`, the hosted terminal Worker, and the deployment wrapper.
3. **Scout:** becomes a workspace package, split into domain, storage, HTTP and analytics modules.
4. **Package:** terminal CLI, `eval`, and splitting `packages/core/src/index.ts`.
5. **Browser and demo:** `site/`, the terminal client and the demo container, with an esbuild step. The JavaScript baseline reaches zero.

The test safety net (API/MCP contract tests and browser smoke tests) lands before the Scout stage.
