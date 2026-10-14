# Website documentation

Domain operations: see the [primary domain migration](site-domain-migration.md) for current routing, email, auth, and deployment constraints. Historical publication records below retain their original domains.

The public documentation lives at https://openmerit.ai/docs/. It uses the homepage's typography, colors, and Cloudflare hosting. Twenty-four guides are generated from Markdown in `docs/`. The terminal is in Get started; demos distinguish hosted samples from the five historical recordings retained in main. Internal website design and maintenance notes are excluded.

Article content has one maintained source: `docs/*.md`. Update those files alongside product changes, then rebuild and deploy. Do not edit the generated `site/docs/` files. The repository's `AGENTS.md` records this rule for future coding work.

## Reference and implementation

The structure draws on [Pi's documentation](https://pi.dev/docs/latest): a grouped left navigation, central article, right page outline, mobile disclosures, and browser search. OpenMerit's presentation and content are its own. The public Pi website repository is an older archived implementation, so it is not a reliable description of Pi's current deployment stack.

- `scripts/docs.config.mjs` controls navigation, routes, titles, and descriptions.
- `scripts/build-docs.mjs` renders Markdown with MarkdownIt and builds a MiniSearch index containing page and section destinations.
- `site/docs.css` supplies the responsive layout; `site/docs.js` adds search, copy feedback, and the active article outline.
- `site/docs-search.js` loads the search assets and recovers from an outdated page after deployment.
- All documentation pages currently share the homepage's default Open Graph/Twitter image. Separate card generation is disabled for now; the optional template is retained in `scripts/social-image.mjs`. See [sharing-image configuration](site-dynamic-og.md).
- `site/docs/` contains generated HTML, downloadable Markdown, the search index, the self-hosted search library and its license, and a manifest. Generated files are ignored by Git.
- Search loads its library and index on the first query of at least two characters. No search query is sent to a search service. Hashed filenames and versioned CSS/JavaScript URLs update with the source or supporting assets. If a tab still references assets removed by a newer deployment, search fetches the current manifest without using its cache and retries with the current library and index. Recovery uses a fresh module URL because browsers can cache failed imports. If recovery also fails, the error message lets the reader retry by typing again; retries do not loop in the background.
- Each page displays the configured **Main branch** label and actions for viewing its source, editing it, and reading generated Markdown. The manifest retains the actual package version separately; a preview version in package metadata is not presented as the stable release. Current guides describe main and distinguish hosted/source appearance changes from npm 0.1.6. There is no historical version selector.

## Pi component structure

The 2026-09-23 component pass follows the rendered [Pi documentation layout](https://pi.dev/docs/latest/quickstart), preserving OpenMerit's font, colors, logo, and article content. Search remains above the central article. Navigation and the article outline are independent panels, with the article in its own bordered reading panel below search. A shared documentation introduction sits above all three columns.

| Before | After | Why |
| --- | --- | --- |
| Navigation, article, and outline shared an undivided surface. | Each has a distinct panel with an appropriate header. | The page's reading and navigation components have clear boundaries. |
| Source and correction links occupied a separate metadata row. | Version, source, edit, and Markdown actions sit beside the article title and wrap below it on narrow screens. | Page-level tools are collected in one compact place. |
| Mobile navigation and the article outline appeared separately. | One native Navigation disclosure contains the current outline and an expandable Documentation list. | Both navigation scopes are available in one component. |
| Heading links navigated to sections. | They also copy the section URL with success feedback when clipboard access works. | Readers can share a precise reference while retaining native anchor behavior. |

At intermediate widths, the documentation rail remains visible and the article outline moves above the article. Narrow layouts use the combined navigation component; its disclosures and section links work without JavaScript. Search and code copying remain available. Previous/next page links are omitted to match Pi's component structure. The component pass introduces no runtime framework or separate article content.

The header contains the OpenMerit brand and Home/GitHub links. The sidebar begins directly with its navigation groups and ends with the documentation scope label. The repeated “Documentation” labels in the header and sidebar, and the sidebar's “Early development” link, were removed on 2026-09-23.

## Editing and previewing

Edit the Markdown source, then run:

```sh
npm ci
npm run check:docs
python3 -m http.server 45831 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:45831/docs/. Rebuild after changing Markdown, navigation, CSS, or JavaScript. To add a page, create a Markdown document beginning with one H1 and add it to the appropriate group in `scripts/docs.config.mjs`. Relative links to published guides are rewritten to their website routes. Other relative Markdown links point to the repository.

`npm run verify` includes the documentation checks. Cloudflare runs `npm run check:docs` before each deployment, so an outdated generated folder or a broken internal link cannot silently pass through the normal deployment command. Publish using the command in [site design and deployment](site-design.md).

The GitHub CI workflow runs verification for pull requests and pushes to `main`; it does not deploy the website. A local edit or successful CI run appears on the public site after a Cloudflare deployment. This publishing step does not require editing the documentation a second time.

## Content review

Before a release or website update, review affected FAQ answers and guides against the published implementation using the [FAQ source map and maintenance procedure](site-faq-maintenance.md). Verify approval, budget, pause, scheduling, data-location, and readiness claims against their implementation. Keep known limitations visible until a released change and relevant verification justify updating them.

For a package release, update source guides and `package.json` together, then rebuild. The build keeps the website synchronized with the maintained Markdown; it does not independently discover changes in product behavior.

## Interaction and layout review

| Before | After | Why |
| --- | --- | --- |
| Documentation links led into the repository. | A consistent reading layout links between product guides. | Readers can follow setup, use, and reference material without losing their place. |
| Repository search was the only search route. | Search links directly to matching documentation sections and supports keyboard browsing. | Commands and operational topics are easier to find. |
| An open tab could lose search after a deployment removed its old search files. | Search recovers using the current deployment manifest. | Readers can keep searching across website updates. |
| Long navigation would crowd a narrow viewport. | Native disclosure controls expose navigation and the article outline. | Reading and navigation remain usable without JavaScript. |
| Code examples required manual text selection. | Copy buttons report success and select text if clipboard access fails. | Examples remain usable when clipboard permission is unavailable. |

Search uses a labeled 16px input, visible focus, native result links, and live status messages. Keyboard feedback is immediate. Hover styling is restricted to hover-capable fine pointers. Code and tables scroll within their own regions; the page keeps native vertical scrolling and permits zoom. Safe-area padding is included. Physical phone hardware has not been tested.

## Verification

The header/sidebar label removal was checked across all 16 generated pages and in Chrome at 1263px and 390px. The main documentation title and package version remain visible, the desktop screenshot was reviewed, and mobile navigation and budget search passed without overflow or runtime errors. All eight documentation checks passed, and 50 deployed URLs across both domains matched the local output.

The 2026-09-23 search review reproduced a production failure with the previous deployment's library and index URLs returning 404. The recovery fix passed locally and on the deployed site in Chrome and WebKit with those outdated URLs, plus separate interrupted index, library, and loader downloads followed by a successful retry. Mouse and emulated-touch result selection, command queries, lazy loading, the two-character minimum, arrow keys, Escape, empty results, and clearing a query while the index was loading passed. Four additional automated tests cover normal loading, recovery when either or both assets are missing, bounded failure, and invalid recovery URLs. `npm run check:docs` now runs eight checks.

The Pi component pass was checked in Chrome and WebKit across all 16 pages at 1440px and 320px, with no page overflow or runtime errors. Screenshots were reviewed at desktop, tablet, and phone-sized widths. Combined mobile navigation, nested documentation lists, outline links, Escape focus restoration, source/edit destinations, and native navigation without JavaScript passed. Section URL copying and code copying passed in Chrome; denied clipboard access preserves section navigation in both engines. Mouse and emulated-touch search selection passed in both engines. Axe WCAG 2 A/AA and 2.1 AA checks passed on the overview, budget tables, adapter examples, and open search at 1440px and 390px. Physical phone hardware was not tested.

The documentation checks validate every local homepage/docs link, asset reference, and section destination; one H1 and unique IDs; exact downloadable Markdown; exclusion of internal site notes; and useful search results for budgets, pause, and rollback.

Chrome browser checks covered all 16 pages at 1440px and 320px with HTTP 200 responses, one H1, and no page overflow. Screenshots covered 1440, 1263, 1024, 768, 390, and 320 CSS pixels. Search lazy loading, the keyboard shortcut, arrow-key navigation, Escape, no results, deep links, history navigation, clipboard success and denied-access fallback, mobile navigation, and article outlines passed. Search also recovered after a failed index request. Reading and mobile navigation passed with JavaScript disabled. No runtime errors were observed.

WebKit also loaded all 16 pages without overflow at 1440px and 390px. Search, keyboard result navigation, Escape, mobile navigation, section links, and the clipboard fallback passed without runtime errors. Axe WCAG 2 A/AA and 2.1 AA checks passed for the overview, budget table, adapter code examples, and open search results at 1440px and 390px after increasing code-label contrast. These are browser and automated accessibility checks, not exhaustive accessibility certification or physical-device validation.

Production smoke testing caught an event-ordering bug in pointer selection: a `focusout` microtask could close the result panel before the clicked link received focus. Closing the panel on a completed `focusin` outside search fixes that race. Mouse and touch result navigation, keyboard browsing, Escape, and moving focus outside search subsequently passed in both Chrome and WebKit. Include actual mouse and touch result selection in future browser reviews alongside keyboard tests.

## Device appearance — published 14 October 2026

Documentation now shares the automatic light/dark website palette. Search results, sidebars, table headers, code examples, mobile disclosures, and focus states follow the device preference without a reload or a theme control. Printing uses light colors. The generator emits appearance metadata before styles load; articles remain maintained exclusively in Markdown. See [theme maintenance](site-themes.md) for verification and the separate publication boundary.
