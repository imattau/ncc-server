import type { Theme } from '@/contexts/AppContext';

const STORAGE_KEY = 'nostr:app-config';

/** The light/dark class a saved theme resolves to right now. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Apply a theme to the document and keep the browser chrome in step. The panel
 * and the welcome page both read the `dark` class.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b110d' : '#f2f3e9');
}

/**
 * Apply the saved theme before React mounts, so a dark-mode operator never
 * sees a white flash on the gate or the welcome page. AppProvider owns the
 * theme after that.
 */
export function applyStoredTheme(): void {
  let theme: Theme = 'system';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const stored = (parsed as { theme?: unknown }).theme;
        if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored;
      }
    }
  } catch {
    // A broken storage entry falls back to the system preference.
  }
  applyTheme(theme);
}
