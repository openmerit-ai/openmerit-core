# Page sharing images

Separate page images are disabled for now at the user's request. The homepage and all documentation page sources use `https://openmerit.ai/assets/openmerit-og-v1.png` for Open Graph and Twitter cards. See the [domain migration status](site-domain-migration.md) for activation and cutover verification. No entries in `scripts/docs.config.mjs` currently enable `socialImage`.

The optional template and workshop artwork remain available for later use. Normal docs builds do not render a separate page card. The previously published `/docs/og.png` path serves a copy of the default image so cached sharing metadata still resolves.

The shared-image configuration is live as Cloudflare version `90bd0c29-5d32-4386-93df-a53e680d9cc5` (2026-09-23). All 11 documentation checks passed. Live Facebook/Twitter crawler checks confirmed default-image metadata and valid image responses on both domains; 54 deployed URLs matched local output.

## Optional template and build

`scripts/social-image.mjs` renders a reusable SVG template to PNG with the pinned `@resvg/resvg-js` development dependency. It combines the text-free workshop asset at `site/assets/openmerit-og-workshop-v1.png` with a heading in the existing `site/assets/inter-latin.woff2` font. The font's SIL Open Font License is retained. There are no network requests, system-font dependencies, or image-generation API calls during builds. The source artwork and exact edit prompt are recorded in [the workshop background notes](site-og-workshop.md).

For an entry with `socialImage: true`, `scripts/build-docs.mjs` passes the maintained page metadata into the renderer, which draws the page title over the workshop. The page description remains in the Open Graph and Twitter description tags. `npm run build:docs` and `npm run check:docs` generate enabled cards, and the existing Cloudflare deployment runs the latter before publishing.

Enabled cards are generated during the build and served as PNGs. They are not rendered separately for each visitor or sharing request. Both default and custom images have an absolute `og:image` URL, PNG type, dimensions, alt text, and a Twitter large-image card. Page titles and descriptions stay specific to each documentation page.

## URLs and future pages

When enabled for the overview, a custom image is written to `site/docs/og.png`, alongside the generated page, and assigned through `https://openmerit.ai/docs/og.png?v=<content-hash>`. The hash comes from the rendered PNG, so changing the title, workshop artwork, font, or template changes the URL when it changes the pixels. Rebuilding the same card produces the same URL. Description or package-version updates do not invalidate an unchanged custom image; those details are not printed on the card.

The physical PNG path stays stable. Previously shared image URLs with an older query parameter still resolve after a deployment instead of pointing to a deleted filename. Social platforms control their own preview caches and may retain a previously fetched card.

To re-enable the optional template after a future user request, add `socialImage: true` to a page's entry in `scripts/docs.config.mjs` and rebuild; the generator assigns an image under that page's route. Do not edit `site/docs/og.png` or the generated HTML.

The template measures and wraps the heading into at most two lines in the upper-left area. If a future title cannot fit, the build fails rather than silently cropping the text or covering the makers. Review new cards at full size and as thumbnails when expanding the rollout.

## Verification and references

The documentation checks validate the assigned Open Graph/Twitter URLs, PNG signature and 1200 × 630 dimensions, image hash, alt text, deterministic regeneration, heading updates, stable artwork when unprinted metadata changes, escaping, and rejection of text that cannot fit. The rendered `/docs/` card is visually reviewed before publishing.

The initial generic card shipped on 2026-09-23 as Cloudflare version `e7791e53-4f0c-4666-89d6-f7d9bc72ae4d`; it was then restyled to match the default workshop OG image at the user's request. Current deployment and live verification are recorded in [site design notes](site-design.md).

The workshop revision shipped as `921eb118-0539-4959-ad5f-e9b928e76d70`, with assigned image `https://openmerit.site/docs/og.png?v=b8404648c9bd`. Full-size and 600 × 315 previews were reviewed against the default image. All 11 documentation checks and script syntax checks passed. Live metadata and image bytes matched for Facebook and Twitter crawler user agents on both domains, older query URLs still resolved, and 54 deployed URLs matched the local build.

Implementation references: [Open Graph metadata and image properties](https://ogp.me/) and [resvg-js](https://github.com/thx/resvg-js). Font provenance and license are recorded in the site assets and [site design notes](site-design.md).
