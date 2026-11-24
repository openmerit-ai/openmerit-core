// Builds app.openmerit.ai into dist/app: one page shell per view with the shared
// sidebar layout, the pages' script (app/main.ts) and the sidebar script. The
// shells show a loading state; app/main.ts signs in and fills them from the
// cloud app's /api/*. app/worker.ts serves them.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "app");
const out = join(root, "dist", "app");

// The sidebar's project switcher picks the project; its pages are the sidebar's items. The
// organization's pages and the member's own settings open from the profile menu.
const nav = [
  { id: "runs", href: "/", label: "Runs", icon: '<path d="M3 12h4l3-7 4 14 3-7h4"/>' },
  { id: "tasks", href: "/tasks/", label: "Tasks", icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>' },
  // An action item, shown with its count only while a repository review's evals wait for review (app/main.ts).
  { id: "evals", href: "/evals/", label: "Review evals", icon: '<path d="M9 5h10M9 12h10M9 19h10M4 5l1 1 2-2M4 12l1 1 2-2M4 19l1 1 2-2"/>', hidden: true },
  { id: "guardrails", href: "/guardrails/", label: "Guardrails", icon: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/>' },
  { id: "project", href: "/project/", label: "Project settings", icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>' },
] as const;

const accountPages = [
  { id: "account", href: "/account/", label: "Account settings", icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>' },
  { id: "connections", href: "/connections/", label: "Coding agents", icon: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>' },
  { id: "plan", href: "/plan/", label: "Plan and usage", icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>' },
  { id: "data", href: "/data/", label: "Your data", icon: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>' },
] as const;

// Each view's shell: its title, the sidebar item it marks, and its address.
const pages = [
  { view: "runs", title: "Runs", nav: "runs", path: "/" },
  { view: "run", title: "Run report", nav: "runs", path: "r" },
  { view: "tasks", title: "Tasks", nav: "tasks", path: "tasks" },
  { view: "evals", title: "Review evals", nav: "evals", path: "evals" },
  { view: "project", title: "Project settings", nav: "project", path: "project" },
  { view: "account", title: "Account settings", nav: "account", path: "account" },
  { view: "connections", title: "Coding agents", nav: "connections", path: "connections" },
  { view: "guardrails", title: "Guardrails", nav: "guardrails", path: "guardrails" },
  { view: "plan", title: "Plan and usage", nav: "plan", path: "plan" },
  { view: "data", title: "Your data", nav: "data", path: "data" },
] as const;

const escape = (text: string): string => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

// What a page shows until its data arrives.
const loading = (view: string, title: string): string => `        <div id="view" data-view="${view}" data-title="${escape(title)}" aria-busy="true">
          <div class="eyebrow"><span class="skeleton" style="width: 120px"></span></div>
          <h1 class="title">${escape(title)}</h1>
          <p class="lede"><span class="skeleton" style="width: min(560px, 90%)"></span></p>
          <section><span class="skeleton block"></span></section>
          <p class="sr-only">Loading…</p>
          <noscript><p class="lede">These pages need JavaScript.</p></noscript>
        </div>`;

const icon = (paths: string): string =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Applied before first paint so a saved Expand-on-hover sidebar does not flash open.
const initialMode = `<script>try{if(localStorage.getItem("om-sidebar")==="hover")document.documentElement.dataset.sidebar="hover"}catch(e){}</script>`;

function page(title: string, active: string, body: string): string {
  const current = (id: string): string => (id === active ? ' aria-current="page"' : "");
  const links = nav.map((item) => `<a class="nav-item${"hidden" in item ? " nav-action" : ""}" href="${item.href}" title="${item.label}"${current(item.id)}${"hidden" in item && item.id !== active ? " hidden" : ""}>${icon(item.icon)}<span class="label">${item.label}</span>${"hidden" in item ? '<span class="count" aria-label="waiting"></span>' : ""}</a>`).join("\n        ");
  const menuLinks = accountPages.map((item) => `<a role="menuitem" href="${item.href}"${current(item.id)}>${icon(item.icon)}${item.label}</a>`).join("\n            ");
  const onAccountPage = accountPages.some((item) => item.id === active);
  return `<!DOCTYPE html>
<html lang="en" data-sidebar="fixed">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1280">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex">
  <title>${title} · OpenMerit</title>
  ${initialMode}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preload" href="/assets/geist-sans.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/app.css">
  <script src="/sidebar.js" type="module"></script>
  <script src="/main.js" type="module"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="Sidebar">
      <div class="sidebar-panel">
        <div class="sidebar-head">
          <a class="brand" href="/" aria-label="OpenMerit runs">
            <svg class="brand-mark" viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg>
            <span class="label">openmerit</span>
          </a>
          <button class="sidebar-toggle" type="button" aria-label="Collapse sidebar" title="Collapse sidebar (Ctrl or ⌘ + B)">${icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>')}</button>
        </div>
        <div class="project-switch-wrap">
          <button class="project-switch" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="project-menu" title="Switch project">
            <span class="project-mark" aria-hidden="true"></span>
            <span class="label"><span class="sub">Project</span><span class="project-name"><span class="skeleton" style="width: 100px"></span></span></span>
            ${icon('<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>')}
          </button>
          <div class="project-menu" id="project-menu" role="menu" aria-label="Projects" hidden></div>
        </div>
        <nav class="nav" aria-label="Sections">
        ${links}
        </nav>
        <div class="sidebar-foot">
          <button class="profile${onAccountPage ? " current" : ""}" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="profile-menu" title="Account">
            <span class="avatar" aria-hidden="true"></span>
            <span class="label"><span class="skeleton" style="width: 110px"></span><span class="sub"><span class="skeleton" style="width: 80px"></span></span></span>
            ${icon('<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>')}
          </button>
          <div class="profile-menu" id="profile-menu" role="menu" aria-label="Account" hidden>
            <div class="menu-who"><span class="avatar" aria-hidden="true"></span><span>…</span></div>
            ${menuLinks}
            <hr>
            <a role="menuitem" href="#" data-global="organizations">${icon('<path d="M7 16 3 12l4-4M17 8l4 4-4 4M3 12h18"/>')}<span>Switch organization</span></a>
            <a role="menuitem" href="#" data-global="sign-out">${icon('<path d="M9 4H5v16h4M14 8l4 4-4 4M18 12H9"/>')}<span>Sign out</span></a>
          </div>
        </div>
      </div>
    </aside>
    <div class="content">
      <main id="main">
${body}
      </main>
    </div>
  </div>
</body>
</html>
`;
}

const notFound = `        <h1 class="title">Page not found</h1>
        <p class="lede">This page does not exist. <a href="/">Back to runs</a></p>`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const { view, title, nav, path } of pages) {
  const target = join(out, path, "index.html");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, page(title, nav, loading(view, title)));
}
writeFileSync(join(out, "404.html"), page("Not found", "none", notFound));
cpSync(join(source, "assets"), join(out, "assets"), { recursive: true });
for (const file of ["app.css", "favicon.svg"]) cpSync(join(source, file), join(out, file));
// The pages inline provider and agent logos, so single-colour ones follow the text colour.
const logos = Object.fromEntries(readdirSync(join(source, "logos")).filter((name) => name.endsWith(".svg")).map((name) => [name.slice(0, -4), readFileSync(join(source, "logos", name), "utf8").trim()]));
const options = { absWorkingDir: root, format: "esm", platform: "browser", target: "es2022", minify: true, bundle: true } as const;
await build({ ...options, entryPoints: ["app/sidebar.ts"], outfile: join(out, "sidebar.js") });
// main.js loads React and Liveline as a separate chunk, only on pages that draw a live chart.
await build({ ...options, entryPoints: ["app/main.ts"], outdir: out, splitting: true, chunkNames: "chunks/[name]-[hash]", define: { __LOGOS__: JSON.stringify(logos), "process.env.NODE_ENV": '"production"' } });
