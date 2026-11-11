'use client';

import { Skeleton } from '@cb/ui';
import dynamic from 'next/dynamic';

/** Own profile only (the ledger is private), so other profiles never load it. */
export const LazyCoinChart = dynamic(() => import('./coin-chart').then((m) => m.CoinChart), {
  loading: () => <Skeleton className="h-48" />,
});
