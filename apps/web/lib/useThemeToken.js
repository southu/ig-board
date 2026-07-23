'use client';

import { useEffect, useState } from 'react';

// Resolve a CSS custom property (theme token) to its current computed value and
// keep it in sync when the [data-theme] attribute flips. Used so SVG marks
// (e.g. the Recharts sparkline stroke) re-color with the theme: the returned
// value is the concrete color string for the active variant, and it changes on
// toggle — satisfying "sparklines re-theme with light/dark" through tokens.
export function useThemeToken(name, fallback = '') {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
      setValue(v || fallback);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    return () => observer.disconnect();
  }, [name, fallback]);

  return value;
}
