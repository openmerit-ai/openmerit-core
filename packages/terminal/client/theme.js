import { useSyncExternalStore } from 'react';

// CSS owns the palette. Canvas charts also need the current device preference
// and resolved colors; subscribe without persisting an application override.
const preference = matchMedia('(prefers-color-scheme: dark)');
const subscribe = notify => {
  preference.addEventListener('change', notify);
  return () => preference.removeEventListener('change', notify);
};
const snapshot = () => preference.matches ? 'dark' : 'light';

export function useSystemTheme() {
  return useSyncExternalStore(subscribe, snapshot);
}

export function chartColor(token) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
}
