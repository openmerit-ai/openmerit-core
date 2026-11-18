// Sidebar for the app.openmerit.ai mockup: Fixed (default), Collapsed (icons only)
// or Expand on hover, saved in localStorage; an off-canvas drawer on narrow screens.
type Mode = "fixed" | "collapsed" | "hover";

const labels: Readonly<Record<Mode, string>> = { fixed: "Fixed", collapsed: "Collapsed", hover: "Expand on hover" };
const isMode = (value: string | null | undefined): value is Mode => value === "fixed" || value === "collapsed" || value === "hover";
const root = document.documentElement;
const modeButton = document.querySelector<HTMLButtonElement>(".mode-button");
const menu = document.querySelector<HTMLElement>(".mode-menu");
const current = document.querySelector<HTMLElement>(".mode-current");
const drawerButton = document.querySelector<HTMLButtonElement>(".menu-toggle");
const scrim = document.querySelector<HTMLElement>(".scrim");

const mode = (): Mode => (isMode(root.dataset.sidebar) ? root.dataset.sidebar : "fixed");

function sync(): void {
  menu?.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((item) => item.setAttribute("aria-checked", String(item.dataset.mode === mode())));
  if (current) current.textContent = labels[mode()];
}

function setMode(next: Mode): void {
  root.dataset.sidebar = next;
  try { localStorage.setItem("om-sidebar", next); } catch { /* private browsing: the choice lasts until reload */ }
  sync();
}

function openMenu(open: boolean): void {
  if (!menu || !modeButton) return;
  if (open) {
    // Fixed position so the menu is not clipped by the collapsed rail.
    const rect = modeButton.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  }
  menu.hidden = !open;
  modeButton.setAttribute("aria-expanded", String(open));
  root.classList.toggle("mode-menu-open", open);
}

function openDrawer(open: boolean): void {
  root.classList.toggle("drawer-open", open);
  drawerButton?.setAttribute("aria-expanded", String(open));
  if (scrim) scrim.hidden = !open;
}

modeButton?.addEventListener("click", () => openMenu(menu?.hidden ?? false));
menu?.addEventListener("click", (event) => {
  const item = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-mode]") : null;
  if (!item || !isMode(item.dataset.mode)) return;
  setMode(item.dataset.mode);
  openMenu(false);
  modeButton?.focus();
});
document.addEventListener("pointerdown", (event) => {
  if (menu?.hidden || !(event.target instanceof Node)) return;
  if (!menu?.contains(event.target) && !modeButton?.contains(event.target)) openMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (menu && !menu.hidden) { openMenu(false); modeButton?.focus(); }
    openDrawer(false);
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    setMode(mode() === "fixed" ? "collapsed" : "fixed");
  }
});
drawerButton?.addEventListener("click", () => openDrawer(!root.classList.contains("drawer-open")));
scrim?.addEventListener("click", () => openDrawer(false));
sync();
