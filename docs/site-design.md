# OpenMerit website

The static website lives in `site/` and uses the existing Cloudflare asset configuration in `wrangler.jsonc`. No build or browser framework is required.

## Local preview

From the repository root:

```sh
python3 -m http.server 45831 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:45831/. This port avoids another local project's cached service worker on ports 4173 and 4174.

## Cloudflare deployment

Published on 2026-09-23 to https://openmerit.site/ and https://www.openmerit.site/ using the existing `openmerit-site` Worker and routes in `wrangler.jsonc`:

```sh
npx --yes wrangler@4.136.3 deploy
```

Deployment version: `6c8e9b6d-7da8-4654-b097-6a748d01bd08` (published npm installation and automatic setup guidance). Previous version: `2ec895d2-f206-4d30-aa63-6a673fd602b8`.

Production verification: the HTML on both domains and the referenced scripts, stylesheet, font, Pi logo, and four illustrations match the local files. Browser checks confirmed illustration playback, FAQ interaction, loaded images, no runtime errors, and no horizontal overflow at 390px.

## Design and behavior

- Reference: https://kobbe.io/ — quiet typography, warm neutral surfaces, a wide illustration, and generous whitespace. Copy and artwork are original to OpenMerit.
- The page contains the hero, getting-started section, FAQ, and footer.
- Small miniature vignettes accompany setup (prepared tools), the FAQ (two makers comparing notes), and the footer (the workshop dog at rest). See [assets and generation prompts](site-section-artwork.md). They are decorative, lazy-loaded, and deliberately much smaller than the hero.
- `site/illustrations.js` adds local motion to the existing artwork: makers check their tools, the brass pans settle, the open chest lid eases into place, the FAQ makers nod toward their notebook, and the sleeping dog breathes slowly. SVG displacement fields feather to zero around each subject; the benches, ground, and surrounding artwork remain still. Original image files and dimensions are unchanged.
- Each illustration begins after 450ms in view, with a small entrance only on its first appearance. Short gestures alternate with stillness: the hero rests for 6.5s, setup for 11s, FAQ for 9.5s, and the dog for 3.2s between gestures. FAQ interactions do not trigger the scene. Scrolling back into view or returning to the tab restarts playback. A small footer control pauses/resumes all illustration motion and remembers the choice locally.
- Painted effects update at about 30Hz, with unchanged attributes skipped. Frames and repeat timers stop offscreen or in a hidden tab, and motion is disabled by `prefers-reduced-motion`. Static images remain visible without JavaScript or if initialization fails. There are no animation dependencies.
- Responsive navigation, native FAQ disclosures, and a copyable `pi install npm:openmerit` command work without dependencies. The setup section explains automatic onboarding in the user's product repository, evaluation budget and permission confirmation, and evidence gathering during ordinary work. Requirements match the published package: Node.js 22.19+ and Pi 0.87 with a configured provider. Source installation and diagnostics remain in the linked guide. The cost FAQ reflects npm availability. The static content, navigation, and disclosures remain available without JavaScript.
- The self-hosted Inter Latin variable font comes from Google Fonts. Its SIL Open Font License is included at `site/assets/inter-LICENSE.txt`.
- The “Works with pi” link uses Pi’s unmodified [official primary SVG](https://pi.dev/logo.svg), downloaded from its [press kit](https://pi.dev/press-kit) to `site/assets/pi-logo.svg`, and links to https://pi.dev/.
- The 1200 × 630 PNG social card contains only “Good models prove themselves in the work.” and a matching miniature workshop illustration. Open Graph and Twitter metadata reference `site/assets/openmerit-og-v1.png`; see [the generation prompt and asset provenance](site-og-image.md).
- A focused pass with Emil Kowalski's design, animation-review, and mobile skills adds capability-gated hover effects, small pointer press feedback, and instant FAQ indicator updates for keyboard use. See [the review and verification limits](site-skill-review.md).

## Verification

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

Current project asset: `site/assets/workshop-miniature-diverse.webp` (2172 × 724; compressed WebP). The photographic miniature workshop has a racially diverse cast of six makers, retaining their activities, the tool-evaluation story, and 3:1 dimensions. Generated with the built-in imagegen tool; see [the exact edit prompt and provenance](site-artwork-miniature-diverse.md).

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
