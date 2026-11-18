// Sidebar for the app.openmerit.ai mockup: Fixed (default) or Expand on hover, toggled by
// the icon beside the logo or Ctrl/⌘+B and saved in localStorage. The profile button opens
// a menu upward with the account pages. The app has no narrow-screen layout.
type Mode = "fixed" | "hover";

const root = document.documentElement;
const toggle = document.querySelector<HTMLButtonElement>(".sidebar-toggle");
const profile = document.querySelector<HTMLButtonElement>(".profile");
const menu = document.querySelector<HTMLElement>(".profile-menu");

const mode = (): Mode => (root.dataset.sidebar === "hover" ? "hover" : "fixed");
const menuItems = (): HTMLElement[] => Array.from(menu?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);

function sync(): void {
  const label = mode() === "fixed" ? "Collapse sidebar" : "Keep sidebar open";
  toggle?.setAttribute("aria-label", label);
  toggle?.setAttribute("title", `${label} (Ctrl or ⌘ + B)`);
}

function switchMode(): void {
  const next: Mode = mode() === "fixed" ? "hover" : "fixed";
  root.dataset.sidebar = next;
  try { localStorage.setItem("om-sidebar", next); } catch { /* private browsing: the choice lasts until reload */ }
  sync();
}

function openMenu(open: boolean, focusFirst = false): void {
  if (!menu || !profile) return;
  // The class keeps an Expand-on-hover sidebar open while the menu is.
  root.classList.toggle("profile-menu-open", open);
  menu.hidden = !open;
  profile.setAttribute("aria-expanded", String(open));
  if (open && focusFirst) menuItems()[0]?.focus();
}

toggle?.addEventListener("click", switchMode);
profile?.addEventListener("click", (event) => openMenu(menu?.hidden ?? false, event.detail === 0));
menu?.addEventListener("keydown", (event) => {
  const items = menuItems();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (step === undefined) return;
  event.preventDefault();
  items[(index + step + items.length) % items.length]?.focus();
});
document.addEventListener("pointerdown", (event) => {
  if (menu?.hidden || !(event.target instanceof Node)) return;
  if (!menu?.contains(event.target) && !profile?.contains(event.target)) openMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu && !menu.hidden) { openMenu(false); profile?.focus(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    switchMode();
  }
});
sync();
