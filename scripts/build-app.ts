// Builds the app.openmerit.ai mockup into dist/app: wraps each page in app/pages
// with the shared sidebar layout and compiles the sidebar script.
//
// A page starts with `<!-- title: <title> | nav: <section> | path: <url path> -->`;
// a path ending in .html, such as 404.html, names the output file itself.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "app");
const out = join(root, "dist", "app");

const nav = [
  { id: "reports", href: "/", label: "Reports", icon: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>' },
  { id: "watched", href: "/watched/", label: "Watched tasks", icon: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' },
  { id: "connections", href: "/connections/", label: "Connections", icon: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>' },
  { id: "plan", href: "/plan/", label: "Plan and usage", icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>' },
  { id: "data", href: "/data/", label: "Your data", icon: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>' },
] as const;

const icon = (paths: string): string =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Applied before first paint so a saved Collapsed or Expand-on-hover sidebar does not flash open.
const initialMode = `<script>try{var m=localStorage.getItem("om-sidebar");if(m==="collapsed"||m==="hover")document.documentElement.dataset.sidebar=m}catch(e){}</script>`;

function page(title: string, active: string, body: string): string {
  const links = nav.map((item) => `<a class="nav-item" href="${item.href}" title="${item.label}"${item.id === active ? ' aria-current="page"' : ""}>${icon(item.icon)}<span class="label">${item.label}</span></a>`).join("\n        ");
  return `<!DOCTYPE html>
<html lang="en" data-sidebar="fixed">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex">
  <title>${title} · OpenMerit</title>
  ${initialMode}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preload" href="/assets/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/app.css">
  <script src="/sidebar.js" type="module"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="shell">
    <aside class="sidebar" id="sidebar" aria-label="Sidebar">
      <div class="sidebar-panel">
        <a class="brand" href="/" aria-label="OpenMerit reports">
          <svg class="brand-mark" viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg>
          <span class="label">openmerit</span>
        </a>
        <div class="workspace" title="Sahra Health"><span class="avatar" aria-hidden="true">S</span><span class="label">Sahra Health<span class="sub">Cloud plan</span></span></div>
        <nav class="nav" aria-label="Sections">
        ${links}
        </nav>
        <div class="sidebar-foot">
          <div class="user" title="amira@sahra.example"><span class="avatar soft" aria-hidden="true">A</span><span class="label">amira@sahra.example<a class="sub" href="#">Sign out</a></span></div>
          <div class="mode">
            <button class="nav-item mode-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="sidebar-mode-menu" title="Sidebar">${icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>')}<span class="label">Sidebar<span class="mode-current"></span></span></button>
            <div class="mode-menu" id="sidebar-mode-menu" role="menu" aria-label="Sidebar" hidden>
              <button type="button" role="menuitemradio" data-mode="fixed" aria-checked="true">Fixed<span class="sub">Always open</span></button>
              <button type="button" role="menuitemradio" data-mode="collapsed" aria-checked="false">Collapsed<span class="sub">Icons only</span></button>
              <button type="button" role="menuitemradio" data-mode="hover" aria-checked="false">Expand on hover<span class="sub">Opens over the page</span></button>
              <p class="menu-hint">Ctrl or ⌘ + B switches between Fixed and Collapsed</p>
            </div>
          </div>
        </div>
      </div>
    </aside>
    <div class="content">
      <div class="topbar">
        <button class="menu-toggle" type="button" aria-controls="sidebar" aria-expanded="false" aria-label="Open menu">${icon('<path d="M4 7h16M4 12h16M4 17h16"/>')}</button>
        <span class="mock-note">Mockup. Every name, number and price is fictional.</span>
      </div>
      <main id="main">
${body}
      </main>
    </div>
  </div>
  <div class="scrim" hidden></div>
</body>
</html>
`;
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
  writeFileSync(target, page(title, active, text.slice(whole.length)));
}
cpSync(join(source, "assets"), join(out, "assets"), { recursive: true });
for (const file of ["app.css", "favicon.svg"]) cpSync(join(source, file), join(out, file));
await build({ absWorkingDir: root, entryPoints: ["app/sidebar.ts"], outfile: join(out, "sidebar.js"), format: "esm", platform: "browser", target: "es2022", minify: true });
