# Website documentation

The public documentation lives at https://openmerit.site/docs/. It uses the homepage's typography, colors, and Cloudflare hosting. Sixteen curated product guides are generated from Markdown in `docs/`; internal website design and maintenance notes are excluded.

Article content has one maintained source: `docs/*.md`. Update those files alongside product changes, then rebuild and deploy. Do not edit the generated `site/docs/` files. The repository's `AGENTS.md` records this rule for future coding work.

## Reference and implementation

The structure draws on [Pi's documentation](https://pi.dev/docs/latest): a grouped left navigation, central article, right page outline, mobile disclosures, and browser search. OpenMerit's presentation and content are its own. The public Pi website repository is an older archived implementation, so it is not a reliable description of Pi's current deployment stack.

- `scripts/docs.config.mjs` controls navigation, routes, titles, and descriptions.
- `scripts/build-docs.mjs` renders Markdown with MarkdownIt and builds a MiniSearch index containing page and section destinations.
- `site/docs.css` supplies the responsive layout; `site/docs.js` adds search, copy feedback, and the active article outline.
- `site/docs/` contains generated HTML, downloadable Markdown, the search index, the self-hosted search library and its license, and a manifest. Generated files are ignored by Git.
- Search loads its library and index on the first query of at least two characters. No search query is sent to a search service. Hashed filenames and versioned CSS/JavaScript URLs update with the source or supporting assets.
- Each page displays the package version, links to its Markdown source, and offers a GitHub issue link to suggest a correction. This is documentation for the current release, with no historical version selector yet.

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
| Long navigation would crowd a narrow viewport. | Native disclosure controls expose navigation and the article outline. | Reading and navigation remain usable without JavaScript. |
| Code examples required manual text selection. | Copy buttons report success and select text if clipboard access fails. | Examples remain usable when clipboard permission is unavailable. |

Search uses a labeled 16px input, visible focus, native result links, and live status messages. Keyboard feedback is immediate. Hover styling is restricted to hover-capable fine pointers. Code and tables scroll within their own regions; the page keeps native vertical scrolling and permits zoom. Safe-area padding is included. Physical phone hardware has not been tested.

## Verification

The documentation checks validate every local homepage/docs link, asset reference, and section destination; one H1 and unique IDs; exact downloadable Markdown; exclusion of internal site notes; and useful search results for budgets, pause, and rollback.

Chrome browser checks covered all 16 pages at 1440px and 320px with HTTP 200 responses, one H1, and no page overflow. Screenshots covered 1440, 1263, 1024, 768, 390, and 320 CSS pixels. Search lazy loading, the keyboard shortcut, arrow-key navigation, Escape, no results, deep links, history navigation, clipboard success and denied-access fallback, mobile navigation, and article outlines passed. Search also recovered after a failed index request. Reading and mobile navigation passed with JavaScript disabled. No runtime errors were observed.

WebKit also loaded all 16 pages without overflow at 1440px and 390px. Search, keyboard result navigation, Escape, mobile navigation, section links, and the clipboard fallback passed without runtime errors. Axe WCAG 2 A/AA and 2.1 AA checks passed for the overview, budget table, adapter code examples, and open search results at 1440px and 390px after increasing code-label contrast. These are browser and automated accessibility checks, not exhaustive accessibility certification or physical-device validation.

Production smoke testing caught an event-ordering bug in pointer selection: a `focusout` microtask could close the result panel before the clicked link received focus. Closing the panel on a completed `focusin` outside search fixes that race. Mouse and touch result navigation, keyboard browsing, Escape, and moving focus outside search subsequently passed in both Chrome and WebKit. Include actual mouse and touch result selection in future browser reviews alongside keyboard tests.
