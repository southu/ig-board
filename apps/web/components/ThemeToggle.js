'use client';

import { useEffect, useState } from 'react';
import { persistThemeToProfile } from '../lib/auth';

const THEME_KEY = 'ig-board.theme';

// Reflects and controls the theme set by the pre-hydration head script. The
// initial state is read from the DOM (not re-derived) so the button matches
// whatever the inline script already applied — no flash, no mismatch.
export default function ThemeToggle() {
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    const current =
      document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'dark'
        : 'light';
    setTheme(current);
  }, []);

  function toggle() {
    const next =
      document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'light'
        : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore storage failures */
    }
    setTheme(next);
    persistThemeToProfile(next);
  }

  const label = theme === 'dark' ? 'Dark' : 'Light';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      aria-pressed={theme === 'dark'}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
      {label}
    </button>
  );
}
