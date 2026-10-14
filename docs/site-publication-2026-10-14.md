# Website and dashboard publication — 14 October 2026

The current documentation, automatic device appearance, transparent landing-page illustrations, and stable hero animation are published to `openmerit.ai` and `dash.openmerit.ai`. The dashboard comparison remains at `https://dash.openmerit.ai/demo`. No npm release was made; npm 0.1.6 retains its previous interface appearance.

## Deployed versions

- Main website: `62ac686b-2895-4263-8e55-053119d2eb27`.
- Hosted dashboard and comparison: `ee29f3a2-e117-4098-b582-88018b621dfa`.
- Domain router: unchanged from `7e5cbee3-1c26-4cb8-afd6-07b6a092ee31`.

The dashboard used `npm run deploy:dash-preview`, including its build, documentation checks, syntax checks, and 193 terminal tests. The website used Cloudflare's version and asset-upload APIs against the preserved production application, as required by the [domain migration constraints](site-domain-migration.md). The root Wrangler configuration was not deployed.

## Preserved application and updated assets

Before publication, the active website version was `08a1ad0f-ae83-4179-a4e9-a174ba746b71`; the dashboard version was `49abf964-8633-466a-a4c6-29cdc8007f55`. Their modules and binding metadata were backed up. The website asset staging retained 81 existing public files, then overlaid the reviewed homepage, shared styles, artwork, engineering presentation, and generated documentation. Cloudflare's edge-injected analytics script was removed from captured HTML before upload; the existing zone continues adding it once.

The protected memo was never uploaded as a public static asset. Its deployed application module was preserved, with only two appearance-metadata replacements in its page templates. Memo prose, diagrams, authentication handlers, reader data, secrets, origins, email configuration, Durable Objects, containers, and storage bindings remain unchanged. Binding and runtime metadata were compared before activation.

The interactive demo retains its deployed `guided-20261002-v9` application and JavaScript. Only its stylesheet and appearance metadata changed. A legacy application rule that returned 404 for `/docs/demo*` was narrowed to demo application paths so the maintained demo guides can be served. No inference session was started and no provider calls were made for publication.

The website now generates 24 guides from Markdown. `docs/interactive-demo.md` was recovered from the preserved production-source branch and added to `scripts/docs.config.mjs`, because the live interactive demo links to it. Its introduction explicitly distinguishes the hosted experiment from main's historical recorded player and the dashboard's fictional comparison. Generated files in `site/docs/` remain build output.

## Verification and rollback material

The pre-publication full verification passed all 311 tests. Final documentation checks passed all 12 tests after adding the interactive guide and updating publication distinctions. Live verification compared all 113 staged website assets with their served output, allowing only the existing domain substitution and one Cloudflare analytics injection in HTML. The dashboard HTML, demo HTML, JavaScript, and both chart styles/bundles match the built files byte for byte.

Unauthenticated memo pages, Markdown, reader lists, and CSV downloads still return the email gate with private caching. Foreign-origin authentication requests return 403. The dashboard's private snapshot returns 404 and mutation requests return 405. Legacy and www redirects preserve paths and queries. Browser checks confirmed the live terminal and interactive guides, documentation search, and the dashboard comparison. Email delivery and a new paid demo run were not repeated; their handlers and configuration were preserved.

Private operational backups, upload manifests, exact application patches, deployment responses, and verification results are under `/private/tmp/openmerit-publication-20261014/`. They are not committed. The original versions above remain the rollback references. Do not use an older root source build as rollback: the source divergence still exists. Future main-site deployments must preserve or reconcile the newer memo and interactive-demo application first.
