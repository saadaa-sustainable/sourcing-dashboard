'use client';

import { useEffect } from 'react';

/**
 * The team fills numbers directly, and an accidental mouse-wheel over a focused
 * number field silently changes the value (a real data-entry hazard). This blurs a
 * focused number input the moment the wheel turns over it — the page still scrolls,
 * but the value never changes by scrolling. Spinner arrows are hidden via CSS.
 * Mounted once in the root layout, so it covers every number field in the app.
 */
export function NumberInputGuard() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el instanceof HTMLInputElement &&
        el.type === 'number' &&
        document.activeElement === el
      ) {
        el.blur();
      }
    };
    document.addEventListener('wheel', onWheel, { passive: true });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);
  return null;
}
