// Sidebar for the app.openmerit.ai mockup: Fixed (default) or Expand on hover, toggled by
// the icon beside the logo or Ctrl/⌘+B and saved in localStorage. The project switcher opens a
// menu of the organization's projects, which app/main.ts fills; the profile button opens a menu
// upward with the account pages. The app has no narrow-screen layout.
type Mode = "fixed" | "hover";

const root = document.documentElement;
const toggle = document.querySelector<HTMLButtonElement>(".sidebar-toggle");
// Each menu and the button that opens it. The class keeps an Expand-on-hover sidebar open while one is.
const menus = [
  { button: document.querySelector<HTMLButtonElement>(".project-switch"), menu: document.querySelector<HTMLElement>(".project-menu") },
  { button: document.querySelector<HTMLButtonElement>(".profile"), menu: document.querySelector<HTMLElement>(".profile-menu") },
];

const mode = (): Mode => (root.dataset.sidebar === "hover" ? "hover" : "fixed");
const itemsOf = (menu: HTMLElement): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>("[role=menuitem]"));

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

function openMenu(index: number, open: boolean, focusFirst = false): void {
  menus.forEach(({ button, menu }, at) => {
    if (!button || !menu) return;
    const shown = open && at === index;
    menu.hidden = !shown;
    button.setAttribute("aria-expanded", String(shown));
    if (shown && focusFirst) itemsOf(menu)[0]?.focus();
  });
  root.classList.toggle("profile-menu-open", open);
}

toggle?.addEventListener("click", switchMode);
menus.forEach(({ button, menu }, index) => {
  button?.addEventListener("click", (event) => openMenu(index, menu?.hidden ?? false, event.detail === 0));
  menu?.addEventListener("keydown", (event) => {
    const items = itemsOf(menu);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    items[(at + step + items.length) % items.length]?.focus();
  });
});
document.addEventListener("pointerdown", (event) => {
  if (!(event.target instanceof Node)) return;
  const target = event.target;
  const open = menus.findIndex(({ menu }) => menu && !menu.hidden);
  if (open < 0) return;
  const { button, menu } = menus[open]!;
  if (!menu?.contains(target) && !button?.contains(target)) openMenu(open, false);
});
document.addEventListener("keydown", (event) => {
  const open = menus.findIndex(({ menu }) => menu && !menu.hidden);
  if (event.key === "Escape" && open >= 0) { openMenu(open, false); menus[open]!.button?.focus(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
    event.preventDefault();
    switchMode();
  }
});
sync();
