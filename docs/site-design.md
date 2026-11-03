# OpenMerit website

Domain operations: see the [primary domain migration](site-domain-migration.md) for current routing, email, auth, and deployment constraints. Historical publication records below retain their original domains.

## OpenMerit logo default — unreleased source

The nested-arches mark already used on Scout is the default OpenMerit logo. The homepage, generated documentation and data policy, memo article and access-page templates, retained engineering article and favicon use the same SVG geometry and rounded strokes. Existing wordmarks, page typography, layout and theme colors are unchanged. Generated pages are updated through their generators, not edited directly. This source change does not publish retired routes or deploy the protected memo Worker; that Worker remains blocked until its newer production source is reconciled.

## Two-paragraph homepage — unreleased source

The homepage uses two conversational paragraphs on every screen size: OpenMerit as a model selection layer in the customer's infrastructure, followed by the beta launch of Scout by OpenMerit, its model search agent. The approved opening explains model choice in plain language: doing the job, fitting a budget, speed, security, where data lives, a fallback and knowing when to switch, beyond an eval, a skill or an “auto” setting. It uses no em dashes, replaces the speed-dating metaphor and retains the token-sales joke (“we checked, it’s a very crowded business”). The first still states that OpenMerit is not a router, does not sit in the live request path and does not sell tokens, ending with an underlined “Optimum Inference For All” memo-title link to `/memo/`; the second describes task-based model search weighing quality and cost for text, code and vision, without implementation detail. Rounded coverage figures (400+ catalogue models, results from 30+ labs, 500+ benchmark series and 200+ source feeds) were checked against the live status endpoint on 29 October 2026: 449 models, 39 labs, 577 series and 212 distinct feed IDs. These static figures need rechecking when the copy changes; they are not live counters. Only 290 series had matched results, and feed IDs include retained research records, so the copy does not claim every model or series is benchmarked, independent verification or support for all modalities. The memo's existing access controls are unchanged. It has no full/TL;DR toggle and retains the existing typography, header and **Try Scout** CTA. The CTA navigates directly to `/scout/`, with or without JavaScript; the homepage has no client script, installer prompt, clipboard action or native Claude launch. Claude Code setup remains available on Scout. This is not yet deployed; dated reading-mode and handoff descriptions below describe their original releases. The current homepage has no FAQ requiring an update.

## Need for Speed easter egg — homepage source only, 3 November 2026

Hovering “needs for speed” in the first homepage paragraph spirals each word
into one vanishing point while a small car races through the gap; each word
springs back as the car passes it (about 1.2s). Motion follows Emil Kowalski's
animation guidance: a strong ease-out exit, a strong ease-in-out for the car,
a 40ms stagger and a spring (0.6s, bounce 0.3) for the return. `site/speed-egg.ts` (built into the ignored
`site/assets/speed-egg.js`) wraps the words and adds the car; nothing hints at
it at rest, and wrapping is unchanged. It plays once per mouse entry; touch and
reduced-motion users see plain text, as does anyone without JavaScript.

## Thread dividers — homepage source only, 3 November 2026

The homepage's two rules, the short one between the letter paragraphs and the
full-width one above the film, are drawn as slightly wiggly SVG threads by
`site/thread-rule.ts` (built into the ignored `site/assets/thread-rule.js`).
A hovering mouse pulls the nearby part of the thread up to 7px toward it. A
damped spring makes it lag, bounce once softly and settle when released. Touch
input is ignored, reduced-motion users get the still wiggle, and the straight
CSS rule remains without JavaScript.

## Founder video — homepage source only, 31 October 2026

A second section below the existing introduction presents the owner's 53-second
film, with an editorial heading and a wide, uncropped 4:3 player. The supplied
2880 × 2160 recording is encoded as H.264 at CRF 20 with the original AAC audio
and fast-start metadata. The web copy is 108,324,818 bytes; the original is kept
outside Git. Subtitles are burned into the supplied video, not a selectable
caption track. This is a founder introduction, not a product demonstration.

The refined controls follow Amp's compact arrangement: play and mute together
on the left, sans-serif elapsed/duration text, speed and fullscreen on the
right, and a rounded 6px timeline with a bordered playhead. The speed disclosure
uses a checked radio list rather than a native select; Escape and outside
pointer presses dismiss it, and selection returns focus to the trigger.
Mouse movement over the timeline previews a timestamp without seeking.
The section has no eyebrow or monospace typography.
Its heading is “OpenMerit in 53 seconds.” with “Lazim 1 · xhigh” beneath it in
small sans-serif text. The current two-paragraph hero, header and Try Scout
link are unchanged. Only the video loads a new homepage client script.

The owner approved creating the dedicated `openmerit-media` R2 bucket and its
public custom domain `media.openmerit.ai`. The versioned
`/openmerit-introduction-v1.mp4` and `/openmerit-introduction-v1.jpg` objects are
uploaded with the appropriate MIME types and one-year immutable caching.
Public HTTPS access, cache hits and HTTP 206 byte-range responses were checked.
This bucket contains only public media; Scout's catalogue remains separate.
Replace media with new versioned keys rather than overwriting immutable URLs.
No Worker binding or new Worker is needed for media delivery.

The homepage uses a poster and `preload="none"`: the MP4 is not requested until
playback or seeking. Custom controls provide play/pause/replay, scrubbing,
mute, playback speed and fullscreen; they remain visible below the picture.
With the player focused, Space/K, Left/Right, M and F control playback,
five-second seeking, mute and fullscreen. Native controls remain available if
JavaScript fails or is disabled. iPhone fullscreen uses Safari's native video
API when element fullscreen is unavailable; physical iPhone playback has not
been verified. Load failures offer a direct video link. No autoplay, external
player, video analytics or tracking is added.

`site/video-player.ts` is compiled by the existing browser build into the
ignored `site/assets/video-player.js`; both docs and Scout builds generate it.
The player follows the device's light/dark appearance and keeps 44px toolbar
targets on mobile. The homepage currently has no FAQ, and this change makes no
new claims about released model-evaluation behavior. Local checks do not
publish the homepage; deploy `scout-serving` through the normal workflow.

Chromium checks exercised play/pause, seek, mute, speed, keyboard shortcuts,
fullscreen, completion and replay at desktop and 390px widths. Poster layouts
were inspected at 1440px light/dark, 390px and 320px with no horizontal overflow.
No MP4 request occurred before interaction; native no-JavaScript controls,
failed-download fallback and pausing during a delayed load were also checked.
The final encode fully decoded without errors. `npm run verify` passed using
Node 22.19.0 and `TMPDIR=/private/tmp`; the default macOS symlinked temporary
path exposes an existing updater-entry test failure unrelated to this player.

## Scout setup analytics default — source only, 25 October 2026

The homepage's copied/deep-linked command now starts with `npx`, without
`DO_NOT_TRACK=1` or an analytics-enabling prefix. Scout setup analytics defaults
on in the source installer; terminal/evaluation analytics stay opt-in. Explicit
opt-outs remain supported, including Scout's privacy-aware handoff. The homepage
still generates no browser setup ID. Publish the updated npm installer before
deploying these prompts; neither release is implied by local checks. See the
[setup contract](scout.md#scout-setup-analytics-default-version-0110).

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

The website lives in `site/` and uses the existing Cloudflare asset configuration in `wrangler.jsonc`. The homepage is plain HTML, CSS, and JavaScript. The [documentation section](site-documentation.md) is generated from curated Markdown at build time; no browser framework is required. The guided demo adds a Worker API and temporary Cloudflare Containers; Docker must be running for deployment.

The playback-only revision is published as Worker `31c181c9-c083-4eb4-85a4-f47516eba877`, build `demo-20260928-fieldkit-v1`. It removes live sandbox controls, disables public session creation, adds a dedicated Demo documentation group, and adds the six-task Field kit recording. Each of the five examples has a persistent two-sentence description below its tabs. Both Field kit paths already use six distinct models; five assignments change while the feasibility model is retained. The recorded comparison shows 22% lower observed cost and 13% lower mean latency, with 4/4 evaluation and 4/4 separate verification goals passing. The deployment history below describes earlier published behavior.

## Local preview

From the repository root:

```sh
npm run check:docs
python3 -m http.server 45831 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:45831/. This port avoids another local project's cached service worker on ports 4173 and 4174.

## Cloudflare deployment

The 2026-09-28 guided demo was introduced as Worker version `db7f39aa-aca8-47c6-b4a3-5681d91b1bfd`. The preceding version `4a68a965-108a-4154-9f44-2fa229202988` includes top-level Single task and Agent workflow tabs. Single task retains support tickets and the Jev spam filter; Agent workflow contains Backfill recovery and GPU placement examples, each with three dependent tasks and stricter constraints. GPU placement uses application models released within March 28–September 28, 2026, with dated source links in Run details. The mixed-route revision displays the model assigned to each task in both columns, with aggregate whole-goal metrics. Both show mean latency alongside cost, with percentage changes after a verified swap. The run trace is visible below the controls; policy, outputs, and evidence stay in the collapsed details section. It retains the homepage and generated documentation assets; `/demo` plays real recorded runs by default and starts bounded Cloudflare Containers on demand. See demo architecture and live validation. The following record describes the preceding static-site release.

Published on 2026-09-23 to https://openmerit.site/ and https://www.openmerit.site/ using the existing `openmerit-site` Worker and routes in `wrangler.jsonc`:

```sh
npx --yes wrangler@4.136.3 deploy
```

Deployment version: `90bd0c29-5d32-4386-93df-a53e680d9cc5` (all documentation pages share the default OG image; separate cards disabled). Previous version: `921eb118-0539-4959-ad5f-e9b928e76d70` (documentation OG image aligned with the default workshop card).

Production verification: 54 URLs across both domains match the checked local files, including all 16 documentation pages, the homepage, downloadable Markdown samples, docs CSS and JavaScript, the search loader and manifest, both search assets, the shared default OG image, and the legacy docs-image path. The documentation build revision is `e205a278c84e`. Facebook and Twitter crawler user agents received metadata pointing to the default image and matching PNG bytes on both domains; the previous docs-image URL now serves the same default artwork. All 11 documentation checks passed. The homepage retains the “Autonomously.” headline ending and all 13 questions. Documentation behavior is recorded in [the documentation notes](site-documentation.md), and image configuration is recorded in [the sharing-image notes](site-dynamic-og.md). Publication preserves the previously deployed full-resolution hero frames and illustration player.

## Assets

- The self-hosted Inter Latin variable font comes from Google Fonts. Its SIL Open Font License is included at `site/assets/inter-LICENSE.txt`.
- The “Works with pi” link uses Pi’s unmodified [official primary SVG](https://pi.dev/logo.svg), downloaded from its [press kit](https://pi.dev/press-kit) to `site/assets/pi-logo.svg`, and links to https://pi.dev/.
- The 1200 × 630 PNG social card contains only “Good models prove themselves in the work.” and a matching miniature workshop illustration. Open Graph and Twitter metadata reference `site/assets/openmerit-og-v1.png`; see [the generation prompt and asset provenance](site-og-image.md).

## Full-site publication, September 28, 2026

All current website changes were deployed as Worker `6b9dfbd1-d9a0-4f13-9120-4e754774998a`. `npm run verify` passed before publishing, and Cloudflare repeated its build, demo, and documentation checks. All 95 public files matched the local build on both domains (190 byte-for-byte checks), covering the homepage, memo and artwork, 22 documentation guides and their source downloads, all five demo recordings, scripts, styles, fonts, and image assets. Both demo configuration responses report `enabled: false`; no inference session was started. The existing container image was unchanged and reused.

## Automatic appearance — published 14 October 2026

The source styles now follow the device's light or dark preference without a website switch. Shared semantic colors cover the landing page, docs, memo, access forms, engineering article, and both demo presentations. The hero keeps its workshop fixed and registers only the moving maker to remove camera drift between generated poses. See [theme sources, verification, and publication constraints](site-themes.md).
