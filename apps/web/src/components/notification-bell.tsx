'use client';

import { Button, Skeleton } from '@cb/ui';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { useMarkAllRead, useNotifications, useUnreadCount } from '@/lib/notifications';
import { NotificationItem } from './notification-list';

/** Header bell: unread badge (99+) and a small panel with the latest notifications. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount(true);
  const list = useNotifications(open);
  const readAll = useMarkAllRead();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);

  // close on outside click and Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const count = unread.data ?? 0;
  const label = count ? `Notifications, ${count >= 100 ? '99+' : count} unread` : 'Notifications';
  const items = list.data?.pages[0]?.items.slice(0, 8) ?? [];
  return (
    <div className="relative" ref={root}>
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={label}
        title="Notifications"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell />
        {count > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground"
            aria-hidden
          >
            {count >= 100 ? '99+' : count}
          </span>
        )}
      </Button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-11 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-2 shadow-xl"
        >
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-sm font-semibold">Notifications</span>
            {count > 0 && (
              <Button variant="ghost" size="sm" loading={readAll.isPending} onClick={() => readAll.mutate()}>
                Mark all read
              </Button>
            )}
          </div>
          <div className="grid max-h-96 gap-0.5 overflow-y-auto">
            {list.isPending ? (
              <Skeleton className="m-2 h-12" />
            ) : items.length ? (
              items.map((n) => <NotificationItem key={n.id} n={n} onNavigate={() => setOpen(false)} />)
            ) : (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">You’re all caught up.</p>
            )}
          </div>
          <Link
            href="/notifications"
            className="mt-1 block rounded-md px-3 py-2 text-center text-sm text-primary hover:bg-muted"
            onClick={() => setOpen(false)}
          >
            See all
          </Link>
        </div>
      )}
    </div>
  );
}
