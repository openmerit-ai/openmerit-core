# TypeScript migration

All first-party JavaScript, including Workers, browser code, tests and deployment tooling, moves to strictly typechecked TypeScript. Generated output (`dist/`, the esbuild bundles beside `site/` sources, `demo/memo/generated/`) is excluded. `openmerit-core/` and `playground/` have their own `tsconfig.json` with the same flags. Migration happens in stages; this note records the rules and the current state.

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
| `tsconfig.json` | Node.js | `scripts/**/*.ts` |
| `tsconfig.site.json` | Website Workers, their Node.js tests and browser scripts | `demo/**/*.ts` (memo, web Worker, public-site boundary) and the `site/` browser sources; bindings use small structural interfaces until Worker runtime types are committed |

Each Worker gets its own project when its first TypeScript file lands, because generated Worker types declare one global `Cloudflare.Env` per Worker. A browser project arrives with the first browser module.

## Worker binding types

`npm run types:workers` writes binding types for each Wrangler configuration into `types/cloudflare/`, using interfaces `SiteEnv`, `DomainRouterEnv` and `ScoutServingEnv`. CI's `worker-types` job runs `npm run check:worker-types` and fails when a configuration changes without regenerated types. Each `wrangler types` run takes about a minute, so it stays out of `npm run verify`.

Runtime types (about 600 KB per compatibility date) are not committed yet. They are generated for a Worker's project when that Worker migrates. Secrets are not part of the configuration, so each Worker declares its secret names next to its entry point.

## Converting a boundary

One boundary, such as a directory or a Worker, per pull request, with no behavior changes:

1. Format the files, if needed, in a separate commit.
2. `git mv` each `.mjs` to `.ts` and update imports, in a separate commit so history follows the rename.
3. Add types until `npm run typecheck` passes, then `npm run check:typescript -- --update`.
4. Run `npm run verify`. Also run the boundary's extra checks: `wrangler deploy --dry-run --outdir` bundles for Workers and built-asset comparisons for browser code.

## Order

1. **Baseline (done):** strict shared configuration, ratchet, pinned Wrangler, generated binding types.
2. **Scout and the old package (removed, 10 November 2026):** the Scout Workers and the former `openmerit` CLI left the repository; `openmerit-core/` is TypeScript from the start.
3. **Tooling and routers:** `scripts/build-memo.mjs`, `scripts/build-scout.mjs`, `demo/domain-router.mjs` and `demo/domain-migration.mjs` with its test.
4. **Memo views:** `demo/memo/views.mjs`. The JavaScript baseline reaches zero.
