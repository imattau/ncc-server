import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ncc-search:theme';

// index.css defines full dark-mode tokens via Tailwind's class-based dark
// variant (`@custom-variant dark (&:is(.dark *));`), but nothing in this
// app ever added or removed that class, or looked at the OS theme at all --
// confirmed by grepping for it before writing this hook. The app was
// permanently light-mode regardless of system preference until now.

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStored(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => readStored() ?? getSystemTheme());

  // useLayoutEffect, not useEffect: this must apply before the browser's
  // first paint, not after, or a dark-OS-preference user briefly sees a
  // flash of the light theme on every load.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Follow the OS theme live, but only for as long as the user hasn't made
  // an explicit choice of their own -- once they pick a theme, it sticks
  // regardless of what the system does afterward.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (readStored() === null) setThemeState(getSystemTheme());
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal: the choice still applies for this page view.
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
