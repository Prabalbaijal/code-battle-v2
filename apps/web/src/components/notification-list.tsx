'use client';

import type { Notification } from '@cb/contracts';
import { cn, UserAvatar } from '@cb/ui';
import Link from 'next/link';
import { describe, timeAgo, useMarkRead } from '@/lib/notifications';

const actorOf = (n: Notification) =>
  n.type === 'friend_request' || n.type === 'challenge_received'
    ? n.payload.from
    : n.type === 'friend_accepted'
      ? n.payload.by
      : n.payload.opponent;

/** Shared by the header bell and the /notifications page. Opening one marks it read. */
export function NotificationItem({ n, onNavigate }: { n: Notification; onNavigate?: () => void }) {
  const read = useMarkRead();
  const { text, href } = describe(n);
  const actor = actorOf(n);
  const unread = n.readAt === null;
  const body = (
    <>
      {actor ? (
        <UserAvatar name={actor.fullname || actor.username} src={actor.avatarUrl} size="sm" />
      ) : (
        <span className="size-8 shrink-0 rounded-full bg-muted" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', unread ? 'font-medium' : 'text-muted-foreground')}>{text}</span>
        <span className="text-xs text-muted-foreground">{timeAgo(n.createdAt)}</span>
      </span>
      {unread && (
        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" role="img" />
      )}
    </>
  );
  const cls = 'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-muted';
  const open = () => {
    if (unread) read.mutate(n.id);
    onNavigate?.();
  };
  return href ? (
    <Link href={href} className={cls} onClick={open}>
      {body}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={open}>
      {body}
    </button>
  );
}
