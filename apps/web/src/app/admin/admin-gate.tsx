'use client';

import { Skeleton } from '@cb/ui';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/people';
import { canAuthor } from '@/lib/problems';
import { useRequireAuth } from '@/lib/session';

/** UX only: the gateway and problem-service enforce the role on every request. */
export function AdminGate({ children }: { children: ReactNode }) {
  const me = useRequireAuth();
  if (me.isPending || me.data === null) return <Skeleton className="h-40 w-full" />;
  if (!canAuthor(me.data)) {
    return (
      <EmptyState icon={<ShieldAlert aria-hidden />} title="Problem setters only">
        Your account can't author problems. Ask an admin for the problem setter role.
      </EmptyState>
    );
  }
  return children;
}
