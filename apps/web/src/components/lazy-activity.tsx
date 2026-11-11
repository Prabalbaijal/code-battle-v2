'use client';

import { Skeleton } from '@cb/ui';
import dynamic from 'next/dynamic';

/** Own profile only (built from the private ledger). */
export const LazyActivityHeatmap = dynamic(
  () => import('./activity-heatmap').then((m) => m.ActivityHeatmap),
  { loading: () => <Skeleton className="h-28" /> },
);
