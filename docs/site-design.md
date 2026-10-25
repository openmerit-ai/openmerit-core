# OpenMerit website

Domain operations: see the [primary domain migration](site-domain-migration.md) for current routing, email, auth, and deployment constraints. Historical publication records below retain their original domains.

## Homepage scope note removal — published 25 October 2026

The owner requested removal of the scope note below the Claude setup CTA.
It is removed from the shared actions in both reading modes. The supplied
homepage copy, toggle and setup behavior are unchanged. The owner approved
deployment through `wrangler.scout-alpha.jsonc` as `openmerit-scout-alpha`
version `50d3b178-e0cd-49f9-b05f-b7c69bb884bd`; only the homepage HTML asset
changed. Live HTML matches source, the note is absent in both reading modes,
and Scout, memo and connection routes remain available while docs/demo remain
404. Desktop and narrow Chromium captures were inspected with no overflow or
runtime errors. The router and protected memo service were not redeployed.

## Conversational homepage — published 25 October 2026

The homepage is now one text-only hero: two owner-supplied conversational
paragraphs, a short Scout beta invitation and **Add OpenMerit to Claude Code**.
A centered editorial column replaces the illustrations, installation section,
FAQ and footer. The header keeps Scout and the restored protected memo links.
The existing paper/ink colors follow the device's light or dark preference;
new letter styles do not change the memo or Scout layouts.

The page starts directly with the prose, without an eyebrow or visible heading.
A screen-reader-only OpenMerit heading preserves the page structure.
At widths up to 600px, the supplied TL;DR is the default; larger screens start
with the full copy. An underlined **Read full** / **TL;DR** button switches
between them. Defaults follow resizing until the visitor chooses a version;
that choice lasts until reload. Pointer switches fade out for 100ms and in for
180ms using the existing ease-out token. Keyboard and reduced-motion switches
are immediate. Without JavaScript the full copy remains readable.
The first two paragraphs describe the OpenMerit direction, not a released
continuous traffic-replay or decision-based billing service. The beta note
makes that distinction. Scout remains the available beta;
this redesign does not add model evaluations, automatic changes or billing.

The CTA copies a secret-free installer prompt and requests the existing
`claude://code/new` handoff. It installs Scout through the existing
`openmerit install --client claude-code` command and browser device approval;
a new Claude Code session must load the installed startup instructions.
The homepage has no analytics preference UI, so its copied command explicitly
uses `DO_NOT_TRACK=1`, with no setup correlation ID. Scout's own setup and
privacy controls are unchanged. A successful copy or launch request does not
establish installation, approval, app launch or invocation.

The CTA itself copies the same prompt carried by the Claude link and confirms
success inline. There is no separate prompt section or disclosure. If clipboard
access fails, an inline message asks the visitor to allow access and retry;
the Claude link still carries the prompt. Without JavaScript the CTA leads
to Scout's existing setup page.

The owner approved publication through `wrangler.scout-alpha.jsonc` as
`openmerit-scout-alpha` version `6b30c07d-207c-4873-8c79-80cccf04d4f7`.
The router, protected memo service and catalogue publisher were not redeployed;
the older root application configuration was not used.
Fifteen live HTTP checks passed: the homepage HTML, script and stylesheet match
source byte-for-byte; Scout's page/client assets, memo sign-in gate and connection
page are unchanged; retired routes remain 404; www and legacy redirects preserve
queries. Production Chromium verified both reading modes at desktop and narrow
widths, correct defaults and expansion state, no horizontal overflow and no
runtime errors. Both default layouts were captured and inspected. Native Claude
launch, completed installation and authenticated Scout/memo flows were not
exercised by this homepage deployment check.

The website lives in `site/` and uses the existing Cloudflare asset configuration in `wrangler.jsonc`. The homepage is plain HTML, CSS, and JavaScript. The [documentation section](site-documentation.md) is generated from curated Markdown at build time; no browser framework is required. The [guided demo](site-demo.md) adds a Worker API and temporary Cloudflare Containers; Docker must be running for deployment.

The playback-only revision is published as Worker `31c181c9-c083-4eb4-85a4-f47516eba877`, build `demo-20260928-fieldkit-v1`. It removes live sandbox controls, disables public session creation, adds a dedicated Demo documentation group, and adds the six-task Field kit recording. Each of the five examples has a persistent two-sentence description below its tabs. Both Field kit paths already use six distinct models; five assignments change while the feasibility model is retained. The recorded comparison shows 22% lower observed cost and 13% lower mean latency, with 4/4 evaluation and 4/4 separate verification goals passing. The deployment history below describes earlier published behavior.

## Local preview

From the repository root:

```sh
npm run check:docs
python3 -m http.server 45831 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:45831/. This port avoids another local project's cached service worker on ports 4173 and 4174.

## Cloudflare deployment

The 2026-09-28 guided demo was introduced as Worker version `db7f39aa-aca8-47c6-b4a3-5681d91b1bfd`. The preceding version `4a68a965-108a-4154-9f44-2fa229202988` includes top-level Single task and Agent workflow tabs. Single task retains support tickets and the Jev spam filter; Agent workflow contains Backfill recovery and GPU placement examples, each with three dependent tasks and stricter constraints. GPU placement uses application models released within March 28–September 28, 2026, with dated source links in Run details. The mixed-route revision displays the model assigned to each task in both columns, with aggregate whole-goal metrics. Both show mean latency alongside cost, with percentage changes after a verified swap. The run trace is visible below the controls; policy, outputs, and evidence stay in the collapsed details section. It retains the homepage and generated documentation assets; `/demo` plays real recorded runs by default and starts bounded Cloudflare Containers on demand. See [demo architecture and live validation](site-demo.md). The following record describes the preceding static-site release.

Published on 2026-09-23 to https://openmerit.site/ and https://www.openmerit.site/ using the existing `openmerit-site` Worker and routes in `wrangler.jsonc`:

```sh
npx --yes wrangler@4.136.3 deploy
```

Deployment version: `90bd0c29-5d32-4386-93df-a53e680d9cc5` (all documentation pages share the default OG image; separate cards disabled). Previous version: `921eb118-0539-4959-ad5f-e9b928e76d70` (documentation OG image aligned with the default workshop card).

Production verification: 54 URLs across both domains match the checked local files, including all 16 documentation pages, the homepage, downloadable Markdown samples, docs CSS and JavaScript, the search loader and manifest, both search assets, the shared default OG image, and the legacy docs-image path. The documentation build revision is `e205a278c84e`. Facebook and Twitter crawler user agents received metadata pointing to the default image and matching PNG bytes on both domains; the previous docs-image URL now serves the same default artwork. All 11 documentation checks passed. The homepage retains the “Autonomously.” headline ending and all 13 questions. Documentation behavior is recorded in [the documentation notes](site-documentation.md), and image configuration is recorded in [the sharing-image notes](site-dynamic-og.md). Publication preserves the previously deployed full-resolution hero frames and illustration player.

## Design and behavior

- Reference: https://kobbe.io/ — quiet typography, warm neutral surfaces, a wide illustration, and generous whitespace. Copy and artwork are original to OpenMerit.
- The page contains the hero, getting-started section, FAQ, and footer.
- The standalone [memo](site-memo.md) is generated from `docs/memo.md` at `/memo/`, with a homepage navigation link and a reading layout using the site's typography and colors. It describes the company's direction separately from released product documentation. The memo, header artwork, and navigation link are published through the existing Cloudflare workflow.
- The [documentation section](site-documentation.md) publishes 24 guides with grouped navigation, section outlines, lazy-loaded browser search, copyable examples, and mobile disclosures. It builds from maintained Markdown and validates local links before deployment.
- The FAQ has 13 questions covering the harness boundary, supported adapters, evaluations, model tradeoffs, evidence, approvals, regressions, background checks, pause, data, cost, budget enforcement, and readiness. Claims are reviewed against the published release using the [FAQ maintenance procedure](site-faq-maintenance.md). The 0.1.5 pause limitation is explicit; budget and evidence checks are described without implying independent enforcement or evidence authentication.
- Small miniature vignettes accompany setup (prepared tools), the FAQ (two makers comparing notes), and the footer (the workshop dog at rest). See [assets and generation prompts](site-section-artwork.md). They are decorative, lazy-loaded, and deliberately much smaller than the hero.
- `site/illustrations.js` plays sequences of separately generated poses: the seated maker raises a hand plane, the toolbox lid closes and opens, the FAQ makers point across their notebook, and the dog lifts its head. The hero uses four individual 2172 × 724 images; eight poses for each supporting scene are packed into WebP atlases. A canvas copies complete frames with no displacement filters, morphing, crossfades, or procedural deformation. See [the sequence assets, exact prompts, and packaging notes](site-illustration-sequences.md) and [the hero resolution correction](site-hero-resolution.md).
- Playback steps forward and back through the poses, with a short hold at each end. The first pose rests for 1.1s in the hero, 1.4s in setup and FAQ, and 2.4s in the footer. The final pose holds for 0.7s, 0.6s, 1s, and 1.6s respectively. Intermediate frames last 120–180ms. FAQ interactions do not trigger the scene. A footer control freezes/resumes the current pose and remembers the choice locally.
- Atlases load only when the illustration is visible and motion is allowed. Timers run only when a different frame is due and stop offscreen or in a hidden tab. Reduced motion displays the static first-frame poster. Posters also work without JavaScript or if an atlas fails to load. There are no animation dependencies.
- Responsive navigation, native FAQ disclosures, and a copyable `pi install npm:openmerit` command work without dependencies. The setup section explains automatic onboarding in the user's product repository, evaluation budget and permission confirmation, and evidence gathering during ordinary work. Requirements match the published package: Node.js 22.19+ and Pi 0.87 with a configured provider. Source installation and diagnostics remain in the linked guide. The cost FAQ reflects npm availability. The static content, navigation, and disclosures remain available without JavaScript.
- The self-hosted Inter Latin variable font comes from Google Fonts. Its SIL Open Font License is included at `site/assets/inter-LICENSE.txt`.
- The “Works with pi” link uses Pi’s unmodified [official primary SVG](https://pi.dev/logo.svg), downloaded from its [press kit](https://pi.dev/press-kit) to `site/assets/pi-logo.svg`, and links to https://pi.dev/.
- The 1200 × 630 PNG social card contains only “Good models prove themselves in the work.” and a matching miniature workshop illustration. Open Graph and Twitter metadata reference `site/assets/openmerit-og-v1.png`; see [the generation prompt and asset provenance](site-og-image.md).
- A focused pass with Emil Kowalski's design, animation-review, and mobile skills adds capability-gated hover effects, small pointer press feedback, and instant FAQ indicator updates for keyboard use. See [the review and verification limits](site-skill-review.md).

## Verification

- The 2026-09-23 hero resolution correction was checked in Chromium and WebKit at 1440 CSS pixels / DPR 2 and 390 CSS pixels / DPR 3. All four source frames and the canvas retain 2172 × 724 pixels, all poses render distinct pixels, and no low-resolution v1 hero assets are loaded. Supporting animations, pause/resume persistence, reduced motion, sharp fallback for missing or undersized frames, no-JavaScript rendering, and overflow checks passed. See [the sources, prompts, and verification details](site-hero-resolution.md).
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

Current project assets: four full-size hero frames, three supporting frame atlases, and the supporting static posters in `site/assets/motion/`. Every hero frame and its poster are 2172 × 724; the supporting posters are 543 × 362. See [sequence provenance and prompts](site-illustration-sequences.md).

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

## Full-site publication, September 28, 2026

All current website changes were deployed as Worker `6b9dfbd1-d9a0-4f13-9120-4e754774998a`. `npm run verify` passed before publishing, and Cloudflare repeated its build, demo, and documentation checks. All 95 public files matched the local build on both domains (190 byte-for-byte checks), covering the homepage, memo and artwork, 22 documentation guides and their source downloads, all five demo recordings, scripts, styles, fonts, and image assets. Both demo configuration responses report `enabled: false`; no inference session was started. The existing container image was unchanged and reused.

## Automatic appearance — published 14 October 2026

The source styles now follow the device's light or dark preference without a website switch. Shared semantic colors cover the landing page, docs, memo, access forms, engineering article, and both demo presentations. The landing-page illustrations retain their poses and full resolution with [transparent backgrounds](site-illustration-transparency.md), so they sit directly on the page in either theme. The hero keeps its workshop fixed and registers only the moving maker to remove camera drift between generated poses. See [theme sources, verification, and publication constraints](site-themes.md); the [publication record](site-publication-2026-10-14.md) identifies the deployed versions.
