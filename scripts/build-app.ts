// Builds the app.openmerit.ai mockup into dist/app: wraps each page in app/pages
// with the shared sidebar layout and compiles the sidebar script.
//
// A page starts with `<!-- title: <title> | nav: <section> | path: <url path> -->`;
// a path ending in .html, such as 404.html, names the output file itself.
// `{{logo:<name>}}` inlines app/logos/<name>.svg, so single-colour logos follow the text colour.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "app");
const out = join(root, "dist", "app");

// The sidebar lists the daily pages; setup and account pages open from the profile menu.
const nav = [
  { id: "runs", href: "/", label: "Runs", icon: '<path d="M3 12h4l3-7 4 14 3-7h4"/>' },
  { id: "tasks", href: "/tasks/", label: "Tasks", icon: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>' },
] as const;

const accountPages = [
  { id: "connections", href: "/connections/", label: "Connections", icon: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>' },
  { id: "plan", href: "/plan/", label: "Plan and usage", icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>' },
  { id: "data", href: "/data/", label: "Your data", icon: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>' },
] as const;

const icon = (paths: string): string =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Applied before first paint so a saved Expand-on-hover sidebar does not flash open.
const initialMode = `<script>try{if(localStorage.getItem("om-sidebar")==="hover")document.documentElement.dataset.sidebar="hover"}catch(e){}</script>`;

function page(title: string, active: string, body: string): string {
  const current = (id: string): string => (id === active ? ' aria-current="page"' : "");
  const links = nav.map((item) => `<a class="nav-item" href="${item.href}" title="${item.label}"${current(item.id)}>${icon(item.icon)}<span class="label">${item.label}</span></a>`).join("\n        ");
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
          <span class="fictional label" title="Every name, number and price here is fictional">Fictional</span>
          <button class="sidebar-toggle" type="button" aria-label="Collapse sidebar" title="Collapse sidebar (Ctrl or ⌘ + B)">${icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>')}</button>
        </div>
        <nav class="nav" aria-label="Sections">
        ${links}
        </nav>
        <div class="sidebar-foot">
          <button class="profile${onAccountPage ? " current" : ""}" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="profile-menu" title="Amira Haddad · Sahra Health">
            <span class="avatar" aria-hidden="true">A<span class="org-badge">S</span></span>
            <span class="label">Amira Haddad<span class="sub">Sahra Health · Cloud plan</span></span>
            ${icon('<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>')}
          </button>
          <div class="profile-menu" id="profile-menu" role="menu" aria-label="Account" hidden>
            <div class="menu-who"><span class="avatar" aria-hidden="true">A<span class="org-badge">S</span></span><span>Amira Haddad<span class="sub">amira@sahra.example</span></span></div>
            ${menuLinks}
            <hr>
            <a role="menuitem" href="#">${icon('<path d="M9 4H5v16h4M14 8l4 4-4 4M18 12H9"/>')}Sign out</a>
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

const logos = new Map(readdirSync(join(source, "logos")).filter((name) => name.endsWith(".svg")).map((name) => [name.slice(0, -4), readFileSync(join(source, "logos", name), "utf8").trim()]));
let logoCount = 0;
function inlineLogos(file: string, html: string): string {
  return html.replace(/\{\{logo:([\w-]+)\}\}/g, (_, name: string) => {
    const svg = logos.get(name);
    if (!svg) throw new Error(`${file}: no app/logos/${name}.svg.`);
    // Gradient ids must stay unique when a logo appears more than once on a page.
    return svg.replace("<svg ", '<svg class="logo" aria-hidden="true" ').replaceAll("_R_0_", `_${logoCount++}`);
  });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of readdirSync(join(source, "pages")).filter((name) => name.endsWith(".html"))) {
  const text = readFileSync(join(source, "pages", file), "utf8");
  const header = /^<!-- title: (.+?) \| nav: (\w+) \| path: (\S+) -->\n/.exec(text);
  if (!header) throw new Error(`${file}: missing the title, nav and path header.`);
  const [whole, title = "", active = "", path = ""] = header;
  const target = path.endsWith(".html") ? join(out, path) : join(out, path, "index.html");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, page(title, active, inlineLogos(file, text.slice(whole.length))));
}
cpSync(join(source, "assets"), join(out, "assets"), { recursive: true });
for (const file of ["app.css", "favicon.svg"]) cpSync(join(source, file), join(out, file));
// live.js loads React and Liveline as a separate chunk, only on pages that draw a chart.
await build({ absWorkingDir: root, entryPoints: ["app/sidebar.ts", "app/live.ts"], outdir: out, bundle: true, splitting: true, chunkNames: "chunks/[name]-[hash]", format: "esm", platform: "browser", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
