# Website memo

Domain operations: see the [primary domain migration](site-domain-migration.md) for current routing, email, auth, and deployment constraints. Historical publication records below retain their original domains.

The standalone `/memo/` page renders [Lazim's supplied memo](memo.md), “Optimum Inference For All.” The Markdown is the single maintained source; its wording and reading links are preserved from the supplied text. It describes the company's direction, including proposed capabilities and business model, rather than the released package contract. The homepage FAQ continues to describe released behavior.

## Editing and building

- Edit `docs/memo.md` for article changes. Do not edit the generated `site/memo/` directory.
- `scripts/docs.config.mjs` records the memo's source, route, and description separately from the product guides. The memo is outside the documentation navigation and operational search index.
- `scripts/build-memo.mjs` runs as part of `scripts/build-docs.mjs`. It renders the supplied H4 sections as H2 headings for a logical outline, assigns section IDs, and copies the exact Markdown to `/memo/source.md`.
- `site/memo.css` supplies the reading layout using the site's existing colors and font. All content and navigation work without JavaScript. Sharing metadata uses the site's default social image.
- A full-width abstract header sits between site navigation and the article. It has no text or overlay, uses a responsive center crop, and reserves its height before the image loads. The decorative image has empty alt text and is omitted from print layouts.
- The homepage navigation links to the memo. Existing Cloudflare asset serving resolves `/memo` to the generated page without a new Worker route.

Run `npm run check:docs`, then use the [existing local preview and deployment workflow](site-design.md). The documentation checks include the memo's local links, assets, section IDs, canonical URL, Markdown source copy, and social metadata. Building or passing checks does not publish the page; Cloudflare deployment is a separate step.

## Local verification

On 2026-09-28, all 11 documentation checks passed. The maintained memo is byte-for-byte identical to the supplied attachment. Browser checks confirmed `/memo` resolves to the article, one H1, nine section headings, ten reading links, and no horizontal overflow at widths from 320px to 1440px. Desktop and phone-sized screenshots were reviewed. The homepage's mobile Menu → Memo link, keyboard skip link, back-to-top link, and Markdown link worked; the complete article and navigation also worked with JavaScript disabled. No browser runtime errors were observed. These were local browser checks; physical phone hardware was not tested. Production asset verification is recorded below.

## Header artwork

The built-in image-generation tool created the header artwork; `site/assets/memo-inference-abstract-v1.webp` is the project asset (2172 × 724 pixels, 296,756 bytes). The visual depicts currents spreading through translucent forms as an abstract interpretation of intelligence, model selection, and shared capacity. WebP encoding is a delivery optimization; no text is added to the image. The original PNG is retained at `/Users/lazim/.codex/generated_images/01a0e79c-c82d-7cb0-8acc-ac542cb5172b/exec-b788a092-99b5-4af7-b441-ee74c0d1d021.png`.

The header addition passed all 11 documentation checks. Browser checks at 320, 390, 768, 1024, 1440, and 1920 CSS pixels confirmed the image loads at its native resolution, spans the viewport width, and creates no horizontal overflow. Desktop and phone-sized screenshots were visually reviewed; no text is present in the artwork and no browser runtime errors were observed. The addition is now published, as recorded below.

### Generation prompt

> Use case: stylized-concept
> Asset type: full-width editorial header image for OpenMerit's founding memo, 'Optimum Inference For All'.
> Primary request: an elegant, completely abstract visual of intelligence becoming more widely distributed through thoughtful allocation of finite resources. No text anywhere.
> Scene and subject: a continuous field of hundreds of very fine graphite and soft sage filaments flowing through a few translucent, mineral-like curved planes of different sizes. Dense ordered currents gradually separate, braid, and spread into an airy, balanced network across the frame. The whole composition feels like one quiet sculptural study of flow, selection, and shared capacity, with subtle irregularity rather than a literal technical diagram.
> Style and materials: sophisticated contemporary editorial art; tactile matte ivory paper, delicate graphite linework, frosted glass, soft mineral forms, restrained film grain. Crisp fine detail with soft natural shadows and substantial open breathing room.
> Color palette: warm off-white matching #f8f7f4, muted sage and olive, charcoal, tiny warm ochre accents. Restrained and luminous, with enough contrast to read at banner size.
> Composition: panoramic landscape, approximately 3:1 aspect ratio, ideally 2400 by 800 pixels. Artwork spans the full width. Important forms and flowing structure stay within the middle vertical band so it crops gracefully on phones. Balanced asymmetry with depth, no central logo-shaped object. Full-bleed artwork, no borders and no text overlay area needed.
> Avoid: ALL letters, words, numbers, captions, labels, logos, signatures, watermarks; no UI, charts, arrows, literal computers, brains, robots, people, sci-fi neon, stock corporate blue, or generic glowing neural network.

## Production publication

Published on September 28, 2026 as Worker `6b9dfbd1-d9a0-4f13-9120-4e754774998a`. The memo HTML, exact Markdown download, stylesheet, and abstract header artwork on both `openmerit.site` and `www.openmerit.site` match the maintained local build byte for byte. The homepage navigation is also published and matched. Repository verification and all 11 documentation checks passed.
