# OpenMerit website

The static website lives in `site/` and uses the existing Cloudflare asset configuration in `wrangler.jsonc`. The homepage is plain HTML, CSS, and JavaScript. The [documentation section](site-documentation.md) is generated from curated Markdown at build time; no browser framework is required.

## Local preview

From the repository root:

```sh
npm run check:docs
python3 -m http.server 45831 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:45831/. This port avoids another local project's cached service worker on ports 4173 and 4174.

## Cloudflare deployment

Published on 2026-09-23 to https://openmerit.site/ and https://www.openmerit.site/ using the existing `openmerit-site` Worker and routes in `wrangler.jsonc`:

```sh
npx --yes wrangler@4.136.3 deploy
```

Deployment version: `c0386712-48d6-4414-9db9-b8238172c4f2` (documentation with corrected mouse/touch search selection). Previous version: `7474c8f4-373a-4cc2-b8f8-deb6c58f5ef5` (published the documentation section and linked the homepage to it).

Production verification: 46 URLs across both domains match the checked local files, including all 16 documentation pages, the homepage, downloadable Markdown samples, docs CSS and JavaScript, and both search assets. The documentation build revision is `b4ccc206fc41`. The homepage retains the “Autonomously.” headline ending and all 13 questions. Production Chrome checks passed for homepage-to-docs navigation, search result selection, budget section links, and mobile command navigation/outline links, without overflow or runtime errors. Documentation publication does not change the previously verified illustration assets or player.

## Design and behavior

- Reference: https://kobbe.io/ — quiet typography, warm neutral surfaces, a wide illustration, and generous whitespace. Copy and artwork are original to OpenMerit.
- The page contains the hero, getting-started section, FAQ, and footer.
- The [documentation section](site-documentation.md) publishes 16 product guides with grouped navigation, section outlines, lazy-loaded browser search, copyable examples, and mobile disclosures. It builds from maintained Markdown and validates local links before deployment.
- The FAQ has 13 questions covering the harness boundary, supported adapters, evaluations, model tradeoffs, evidence, approvals, regressions, background checks, pause, data, cost, budget enforcement, and readiness. Claims are reviewed against the published release using the [FAQ maintenance procedure](site-faq-maintenance.md). The 0.1.5 pause limitation is explicit; budget and evidence checks are described without implying independent enforcement or evidence authentication.
- Small miniature vignettes accompany setup (prepared tools), the FAQ (two makers comparing notes), and the footer (the workshop dog at rest). See [assets and generation prompts](site-section-artwork.md). They are decorative, lazy-loaded, and deliberately much smaller than the hero.
- `site/illustrations.js` plays sequences of separately generated poses: the seated maker raises a hand plane, the toolbox lid closes and opens, the FAQ makers point across their notebook, and the dog lifts its head. Four hero poses and eight poses for each supporting scene are packed into WebP atlases. A canvas copies complete frames with no displacement filters, morphing, crossfades, or procedural deformation. See [the sequence assets, exact prompts, and packaging notes](site-illustration-sequences.md).
- Playback steps forward and back through the poses, with a short hold at each end. The first pose rests for 1.1s in the hero, 1.4s in setup and FAQ, and 2.4s in the footer. The final pose holds for 0.7s, 0.6s, 1s, and 1.6s respectively. Intermediate frames last 120–180ms. FAQ interactions do not trigger the scene. A footer control freezes/resumes the current pose and remembers the choice locally.
- Atlases load only when the illustration is visible and motion is allowed. Timers run only when a different frame is due and stop offscreen or in a hidden tab. Reduced motion displays the static first-frame poster. Posters also work without JavaScript or if an atlas fails to load. There are no animation dependencies.
- Responsive navigation, native FAQ disclosures, and a copyable `pi install npm:openmerit` command work without dependencies. The setup section explains automatic onboarding in the user's product repository, evaluation budget and permission confirmation, and evidence gathering during ordinary work. Requirements match the published package: Node.js 22.19+ and Pi 0.87 with a configured provider. Source installation and diagnostics remain in the linked guide. The cost FAQ reflects npm availability. The static content, navigation, and disclosures remain available without JavaScript.
- The self-hosted Inter Latin variable font comes from Google Fonts. Its SIL Open Font License is included at `site/assets/inter-LICENSE.txt`.
- The “Works with pi” link uses Pi’s unmodified [official primary SVG](https://pi.dev/logo.svg), downloaded from its [press kit](https://pi.dev/press-kit) to `site/assets/pi-logo.svg`, and links to https://pi.dev/.
- The 1200 × 630 PNG social card contains only “Good models prove themselves in the work.” and a matching miniature workshop illustration. Open Graph and Twitter metadata reference `site/assets/openmerit-og-v1.png`; see [the generation prompt and asset provenance](site-og-image.md).
- A focused pass with Emil Kowalski's design, animation-review, and mobile skills adds capability-gated hover effects, small pointer press feedback, and instant FAQ indicator updates for keyboard use. See [the review and verification limits](site-skill-review.md).

## Verification

- The 2026-09-23 FAQ update was checked locally in Chrome at 1440, 390, and 320 CSS pixels. All 13 answers opened, Enter and Space toggled disclosures, and there were no page or answer-content overflows or runtime errors. Desktop and narrow-screen screenshots were visually reviewed. All 13 native disclosures also opened with JavaScript disabled at 390px. FAQ documentation links resolve to existing repository files, IDs are unique, and whitespace checks pass. Published to both domains as version `34defac0-60c3-49a2-9501-9d40ff840ea4`; served HTML matches the checked local file.

- The 2026-09-23 frame-sequence replacement was checked locally and on the deployed site in Chromium and WebKit at 1440px and 390px. All four hero poses and all eight poses in each supporting scene were observed through a full repeat; canvas draws use whole atlas cells with equal source and destination dimensions. Pause freezes the current pose and persists across reload. Resume, runtime reduced motion, offscreen stopping/re-entry, and overflow checks passed without runtime errors. Initial reduced motion avoids atlas downloads; JavaScript-disabled and failed-atlas checks preserve the posters. The HTML, CSS, player, and all eight sequence/poster assets on both domains match the local files. Physical phone hardware was not tested.
- The 2026-09-23 motion visibility fix was checked locally and on the deployed site in Chromium and WebKit at 1440px and 390px. Rendered frame comparisons confirmed movement in all four scenes through the actual playback function. Natural repeat cycles, pause/resume persistence across reload, runtime reduced-motion changes, offscreen stopping and re-entry, no horizontal overflow, and no runtime errors passed in all four browser/viewport combinations. The HTML and versioned illustration script on both domains match the local files. Syntax and whitespace checks passed. Physical phone hardware was not tested.
- The 2026-09-23 install-copy update was checked at 320, 1024, and 1263 CSS pixels, with no page or command overflow. Verified copy success feedback and the revised cost FAQ. The command stays at 14px on narrow layouts; the changed stylesheet and script use versioned URLs to refresh cached previews. These checks used a browser, not physical phone hardware.
- Browser checked at 320, 390, 580, 768, 1024, 1440, and 1920 CSS pixels; no page-level horizontal overflow.
- Checked keyboard operation, mobile navigation and Escape, FAQ expansion, clipboard success and denied-permission fallback.
- Axe WCAG 2 A/AA and 2.1 AA checks found no violations at desktop and mobile sizes. This is an automated check, not a claim of exhaustive accessibility certification.
- Confirmed readable static content, navigation, and FAQ interaction without JavaScript.
- No browser console or runtime errors; local font and artwork load.
- Illustration motion checked at 1440px and 390px: no overflow or visible patch seams; gestures end cleanly, offscreen motion stops, FAQ interaction does not replay the scene, and reduced motion works both on initial load and when changed at runtime. Static artwork and FAQ disclosures also verified with JavaScript disabled.
- After correcting the one-pass behavior, rendered frame pairs confirmed visible pixel changes inside all four scenes. Verified natural repeat/rest cycles, interrupted playback on re-entry, persistent pause/resume, and no horizontal overflow at 320px and 390px. This is browser verification, not physical-phone testing.
- Repository verification: all 35 tests, workspace syntax checks, and TypeScript checks pass.

## Illustration asset

Current project assets: the four frame atlases and matching static posters in `site/assets/motion/`. The hero poster is 1086 × 362; the supporting posters are 543 × 362. See [sequence provenance and prompts](site-illustration-sequences.md).

The original reference remains at `site/assets/workshop-miniature-diverse.webp` (2172 × 724; compressed WebP). The photographic miniature workshop has a racially diverse cast of six makers, retaining their activities and the tool-evaluation story. Generated with the built-in imagegen tool; see [the original edit prompt and provenance](site-artwork-miniature-diverse.md).

The previous miniature artwork remains at `site/assets/workshop-miniature.webp`, with its [original generation prompt](site-artwork-miniature.md).

The earlier linocut is retained at `site/assets/workshop-linocut.webp`; its [prompt and provenance](site-artwork-linocut.md) are preserved.

### Original illustration, retained

Original project asset: `site/assets/workshop.webp` (2172 × 724; compressed WebP).

Generated with the built-in imagegen tool. The uncompressed original is retained at `/Users/lazim/.codex/generated_images/01a0c9d4-a3f3-7e12-aa03-2b46f42b5e83/exec-08953716-7583-4a26-ad48-5262ab6f9ca7.png`. The website uses only the optimized local asset.

### Exact generation prompt

> Use case: illustration-story
> Asset type: original wide editorial illustration for the OpenMerit software website.
> Primary request: an understated hand-drawn illustrated frieze about testing, measuring, and choosing tools by their merit. A small open-air makers' workshop rendered as fine graphite and dark ink crosshatching, like a thoughtful 1950s scientific magazine illustration with very restrained watercolor.
> Scene: six small human craftspeople spaced naturally along one continuous rough wooden workbench and a low stone ground line. From left to right: a woman arriving with a small box of tools; a person carefully measuring a wooden object with calipers; an older seated craftsperson examining three different small mechanical tools on a table with a traditional balance scale; a woman recording observations in a notebook; a person adjusting a modest bench-mounted mechanism; and a person carrying the chosen tool away. A small dog sleeps underneath. Lived-in, patient, humane, charming but not whimsical. Ordinary human proportions. Objects are simply hand tools, no futuristic technology.
> Composition: ultra-wide landscape 3:1 aspect ratio. The entire scene lives in the bottom 55% of the frame. Full figures, heads and feet in frame. Broad empty paper above and very generous empty paper at left and right edges. Delicate fine lines, lots of negative space, no enclosing scenery or buildings. Thin continuous ground under the figures. The art should remain readable as a shallow panoramic strip at the bottom of a web hero.
> Color palette: background flat warm almost-white paper #f8f7f4, ink warm charcoal, very sparse washes of muted olive, faded terracotta, parchment. Mostly monochrome. No paper edge, no vignette, no noisy texture.
> Text: none. No lettering, logo, typography, watermark, UI, charts, robots, glowing effects, bright colors, gradients, 3D, flat vector blobs, or corporate cartoon style. This should look commissioned and drawn by an editorial illustrator, with subtle imperfections and varied poses.
