# Device-driven appearance

Published to the website and hosted dashboard on 14 October 2026. The npm package is unchanged; npm 0.1.6 retains its previous appearance.

The website and Inference Terminal follow `prefers-color-scheme` automatically. There is no theme control, cookie, local-storage preference, or URL override. CSS resolves the initial appearance before application JavaScript runs and updates when the device preference changes. Light is the browser default when no dark preference is supplied. Theme-aware `color-scheme` and media-qualified `theme-color` metadata cover native controls and browser chrome.

## Presentation sources

- `site/styles.css` owns the warm website palette shared by the homepage, generated docs, memo, and engineering article. Reading surfaces, code, search, tables, navigation, forms, and SVG diagram tokens use it. Print output remains light.
- `site/docs.css`, `site/memo.css`, and `site/memo-access.css` style their components using those tokens. The article's local stylesheet entry points import the shared foundations. Its article-specific code and table colors are also theme-aware.
- `packages/terminal/public/styles.css` owns the dashboard palette. `client/routes.mjs` uses semantic route colors for both SVG diagrams and HTML legends. `client/theme.js` subscribes React canvas charts to device changes and reads resolved CSS colors. Inspectors, custom selects, search, and loading/error states use the same palette.

The terminal dark palette retains neutral surfaces. Light surfaces use restrained warm neutrals, with darker route and status colors to retain contrast. Text and controls do not use inversion filters.

## Production source mismatch

The source divergence documented in [domain migration](site-domain-migration.md) still applies. The running main application includes newer memo authentication, protected content, interactive demo handlers, and article generation that this checkout's root Worker does not contain. Do not publish the root Wrangler configuration to deploy these colors.

Presentation-only sources were recovered from `codex/main-before-terminal-2026-10-12` (`d89ebc4`): the memo component stylesheet, memo access stylesheet and view renderer, and interactive demo stylesheet. Auth logic, D1 data, secrets, runtime API handlers, content, package metadata, and domain routing were not replaced. The recovered view renderer carries the two theme-color metadata values for the preserved app's integration. The published interactive demo's HTML received the same metadata (light `#f7f7f5`, dark `#141712`) when integrating its stylesheet. Its existing script and API behavior must be retained.

The protected memo was checked using the existing local generated production snapshot, without modifying that snapshot or authenticating a real reader. The newer interactive demo was checked with its public HTML and local CSS; visible state fixtures exercise status and code styling without inference calls. These are presentation checks, not authentication or inference end-to-end tests. The subsequent publication used the preserved production application and live verification recorded in the publication notes. The dashboard can use the existing terminal-preview build/deployment workflow independently.

## Verification

The full `npm run verify` passes with loopback permissions required by the existing server tests. Documentation is generated from Markdown; no generated files in `site/docs/` are maintained manually.

Browser verification covers light and dark at 1440px and 390px across the homepage, documentation, memo, protected memo (including ten SVG diagrams), email gate, reader table, engineering article, recorded demo, interactive demo presentation, all six dashboard tabs, and the hosted comparison. No page-level horizontal overflow or browser runtime errors were observed. A computed-style text contrast audit caught and corrected subdued inspector labels. This audit is limited to visible text on opaque backgrounds, not an exhaustive accessibility certification. Screenshots were inspected for the dashboard, modal, website artwork, memo diagram, and demo.

Open dropdowns and inspectors update when the device preference changes. Additional checks cover documentation search, static/no-JavaScript reading, narrow mobile navigation, print, and live canvas/flow behavior. Browser emulation is not a physical-device check.
