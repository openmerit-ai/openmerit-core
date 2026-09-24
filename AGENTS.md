# Documentation maintenance

The Markdown files in `docs/` are the source of truth for public documentation. The website at `/docs/` is generated from those files by `scripts/build-docs.mjs`. Do not edit generated files in `site/docs/` or maintain a second copy of an article in website code.

Do not make public claims about the project's licensing or source availability until the user explicitly authorizes that positioning. Preserve the legal license file and package metadata.

When changing user-visible product behavior, update the relevant Markdown guides in the same change. This includes commands, setup, supported versions, protocol contracts, metrics, approvals, budgets, scheduling, pause, data handling, and known limitations. Check affected homepage FAQ claims against the same behavior using `docs/site-faq-maintenance.md`. Distinguish released behavior from unreleased changes; do not describe a planned capability or an unverified outcome as established behavior.

`scripts/docs.config.mjs` controls which guides are public, their navigation labels, routes, and descriptions. Add new public guides there. Internal `site-*` design and maintenance notes remain outside the public documentation navigation.

Run `npm run check:docs` after documentation or documentation-generator changes. It rebuilds the site and validates local links, section destinations, source copies, and search results. Product changes also require the applicable checks in `npm run verify`.

The existing Cloudflare deployment runs the documentation build and checks before publishing. Source edits appear on the live site after deployment; a successful local build or GitHub CI run alone does not publish them. Follow `docs/site-documentation.md` and `docs/site-design.md` for the existing workflow.
