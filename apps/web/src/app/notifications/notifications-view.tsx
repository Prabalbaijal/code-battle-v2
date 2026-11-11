'use client';

import { Alert, Button, Card, Skeleton } from '@cb/ui';
import { BellOff } from 'lucide-react';
import { NotificationItem } from '@/components/notification-list';
import { EmptyState } from '@/components/people';
import { messageFor } from '@/lib/api';
import { useMarkAllRead, useNotifications, useUnreadCount } from '@/lib/notifications';
import { useMe } from '@/lib/session';

export function NotificationsView() {
  const { data: me, isPending: mePending } = useMe();
  // the route is session-gated already: fetch in parallel with /auth/me, not after it
  const list = useNotifications(true);
  const unread = useUnreadCount(true);
  const readAll = useMarkAllRead();

  if (mePending || (me && list.isPending)) {
    return (
      <Card className="grid gap-2 p-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </Card>
    );
  }
  if (!me) return <Alert>Log in to see your notifications.</Alert>;
  if (list.isError) return <Alert variant="destructive">{messageFor(list.error)}</Alert>;

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        {(unread.data ?? 0) > 0 && (
          <Button variant="outline" size="sm" loading={readAll.isPending} onClick={() => readAll.mutate()}>
            Mark all read
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<BellOff />} title="Nothing yet">
          Friend requests, challenges and match results show up here.
        </EmptyState>
      ) : (
        <Card className="grid gap-0.5 p-2">
          {items.map((n) => (
            <NotificationItem key={n.id} n={n} />
          ))}
        </Card>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="justify-self-center"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
