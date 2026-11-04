# Markdown guides and policy/memo build

**Unreleased source cleanup, November 2026:** the unpublished `/docs/` website shell, search index, browser navigation and optional page-image template are retired. Product documentation remains maintained as Markdown in `docs/`, linked from `docs/index.md` and packaged with npm. The live site already took `/docs/` offline on 24 October 2026.

`npm run build:site` runs `scripts/build-site.ts`, rendering only `docs/scout-data-policy.md` at `/scout/data-policy/` with its exact downloadable source and packaged styles. It also builds the protected memo through `scripts/build-memo.mjs` and the existing browser assets. The policy has native heading links and does not depend on docs search/navigation or an analytics loader.

`scripts/memo.config.ts` owns memo metadata. Private article HTML and Markdown go to ignored `demo/memo/generated/content.ts`, never public assets. Only the login gate is written to `site/memo/`; authenticated Worker routes own article delivery. See [memo maintenance](site-memo.md).

Run `npm run check:docs` after guide or build edits. It checks Markdown links/anchors, retained page links/appearance metadata, exact policy source and memo privacy. Run `npm run check:demo` for memo authentication and local D1 tests; passing documentation checks alone does not establish those behaviors.

## Website analytics — source-only, unreleased

The unpublished homepage/docs analytics entry point is removed with the docs shell. The shared Scout browser collector and server/account ingestion remain for live Scout clients; historical event records and retention/deletion obligations are unchanged. No old upload is authorized for activation by this cleanup. Follow [deployment maintenance](site-deployment.md) for any separately approved release.

Builds and CI do not publish pages. Do not edit ignored generated output or deploy directly around the repository wrapper.
