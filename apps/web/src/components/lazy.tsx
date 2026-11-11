'use client';

import dynamic from 'next/dynamic';

/**
 * Layout-level code no page needs for its first paint, split out of the shared bundle (plan §21.4
 * budget: ≤ 170 KB first load). Loaded right after hydration. Page-level lazy pieces live next to
 * what they wrap (lazy-markdown, lazy-coin-chart) so a page only pays for its own loaders.
 */
// socket bridge, challenge modal, "Preparing match…", rejoin banner, notices
export const LazyBattleGlobal = dynamic(() => import('./battle-global').then((m) => m.BattleGlobal), {
  ssr: false,
});
export const LazyNotificationBell = dynamic(
  () => import('./notification-bell').then((m) => m.NotificationBell),
  { ssr: false, loading: () => <span className="size-9" aria-hidden /> },
);
// only shown to unverified users
export const LazyVerifyBanner = dynamic(() => import('./verify-banner').then((m) => m.VerifyBanner), {
  ssr: false,
});
