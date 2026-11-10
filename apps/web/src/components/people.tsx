'use client';

import type { Profile, Relationship } from '@cb/contracts';
import { Badge, Button, Skeleton, UserAvatar } from '@cb/ui';
import { Check, Clock, UserMinus, UserPlus, X } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { isApiError, messageFor } from '@/lib/api';
import {
  useAcceptRequest,
  useCancelRequest,
  useRejectRequest,
  useRemoveFriend,
  useSendFriendRequest,
} from '@/lib/friends';
import { useMe } from '@/lib/session';

/** One person in a list: avatar, names, and whatever actions the caller passes. */
export function PersonRow({ user, meta, actions }: { user: Profile; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <UserAvatar name={user.fullname} src={user.avatarUrl} />
      <div className="min-w-0 flex-1">
        <Link href={`/u/${user.username}`} className="block truncate font-medium hover:underline">
          {user.fullname}
        </Link>
        <p className="truncate text-sm text-muted-foreground">
          @{user.username}
          {meta ? <span> · {meta}</span> : null}
        </p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </li>
  );
}

export function PeopleSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul aria-busy className="divide-y divide-border">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center gap-3 py-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid place-items-center gap-2 py-12 text-center">
      <div className="text-muted-foreground [&_svg]:size-8">{icon}</div>
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-sm text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

/** The friend button for a profile, driven by the viewer-relative `relationship`. */
export function RelationshipActions({ user, relationship }: { user: Profile; relationship: Relationship }) {
  const { data: me } = useMe();
  const send = useSendFriendRequest();
  const accept = useAcceptRequest();
  const reject = useRejectRequest();
  const cancel = useCancelRequest();
  const remove = useRemoveFriend();
  const [error, setError] = useState<string>();
  const onError = (e: unknown) =>
    setError(
      isApiError(e, 'EMAIL_NOT_VERIFIED') ? 'Verify your email to send friend requests.' : messageFor(e),
    );
  const run = <V,>(m: { mutate: (v: V, o: { onError: (e: unknown) => void }) => void }, v: V) => {
    setError(undefined);
    m.mutate(v, { onError });
  };

  if (relationship === 'self') return <Badge variant="secondary">This is you</Badge>;

  const body = (() => {
    switch (relationship) {
      case 'friends':
        return (
          <>
            <Badge variant="success">
              <Check className="size-3" aria-hidden /> Friends
            </Badge>
            <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => run(remove, user.id)}>
              <UserMinus /> Remove
            </Button>
          </>
        );
      case 'incoming':
        return (
          <>
            <Button size="sm" loading={accept.isPending} onClick={() => run(accept, user.id)}>
              <Check /> Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={reject.isPending}
              onClick={() => run(reject, user.id)}
            >
              <X /> Decline
            </Button>
          </>
        );
      case 'outgoing':
        return (
          <Button size="sm" variant="outline" loading={cancel.isPending} onClick={() => run(cancel, user.id)}>
            <Clock /> Requested · Cancel
          </Button>
        );
      default:
        return (
          <Button size="sm" loading={send.isPending} disabled={!me} onClick={() => run(send, user.id)}>
            <UserPlus /> Add friend
          </Button>
        );
    }
  })();

  return (
    <div className="grid justify-items-end gap-1">
      <div className="flex flex-wrap items-center gap-2">{body}</div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
