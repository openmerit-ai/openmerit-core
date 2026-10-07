// Hand-drawn on a 20-unit grid. Shape describes the connection, not its status.
const glyphs = {
  direct: '<circle cx="3.5" cy="10" r="1.75"/><path d="M5.25 10h9.5"/><circle cx="16.5" cy="10" r="1.75"/>',
  local: '<path d="M7 5h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM8 2v3m4-3v3M8 15v3m4-3v3M2 8h3m-3 4h3m10-4h3m-3 4h3M8 8h4v4H8Z"/>',
  router: '<circle cx="3" cy="10" r="1.5"/><path d="M4.5 10H8a2 2 0 0 0 2-2V6a2 2 0 0 1 2-2h3.5M8 10a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h3.5"/><circle cx="17" cy="4" r="1.5"/><circle cx="17" cy="16" r="1.5"/>',
  gateway: '<path d="M7 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 14v2a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-2M2 10h16m-3-3 3 3-3 3"/>',
  unknown: '<path d="M7 3.7a7 7 0 0 1 6 0M16.3 7a7 7 0 0 1 0 6M13 16.3a7 7 0 0 1-6 0M3.7 13a7 7 0 0 1 0-6"/><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none"/>',
};

export function routeIcon(kind) {
  return `<svg class="route-icon" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${glyphs[kind] ?? glyphs.unknown}</svg>`;
}
