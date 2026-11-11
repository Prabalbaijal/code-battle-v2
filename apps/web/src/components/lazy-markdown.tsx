'use client';

import { Skeleton } from '@cb/ui';
import dynamic from 'next/dynamic';

/** react-markdown + remark/rehype + KaTeX ≈ 120 KB gzip: loaded alongside the page, not in it. */
export const LazyMarkdown = dynamic(() => import('./markdown').then((m) => m.Markdown), {
  loading: () => (
    <div className="grid gap-2" aria-busy>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  ),
});
