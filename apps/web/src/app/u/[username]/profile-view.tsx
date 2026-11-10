'use client';

import { Alert, Card, Skeleton, UserAvatar } from '@cb/ui';
import { CalendarDays, UserX } from 'lucide-react';
import { EmptyState, RelationshipActions } from '@/components/people';
import { isApiError, messageFor } from '@/lib/api';
import { useProfile } from '@/lib/friends';

export function ProfileView({ username }: { username: string }) {
  const profile = useProfile(username);

  if (profile.isPending) {
    return (
      <Card className="flex items-center gap-5 p-6">
        <Skeleton className="size-20 rounded-full" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </Card>
    );
  }
  if (profile.isError) {
    return isApiError(profile.error, 'NOT_FOUND') ? (
      <EmptyState icon={<UserX />} title="Player not found">
        No one goes by @{username}.
      </EmptyState>
    ) : (
      <Alert variant="destructive">{messageFor(profile.error)}</Alert>
    );
  }

  const p = profile.data;
  const joined = new Date(p.createdAt).toLocaleDateString('en', { month: 'long', year: 'numeric' });
  return (
    <div className="grid gap-6">
      <Card className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center">
        <UserAvatar name={p.fullname} src={p.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">{p.fullname}</h1>
          <p className="text-muted-foreground">@{p.username}</p>
          {p.bio && <p className="mt-2 max-w-prose text-sm">{p.bio}</p>}
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="size-3.5" aria-hidden /> Joined {joined}
          </p>
        </div>
        {p.relationship && <RelationshipActions user={p} relationship={p.relationship} />}
      </Card>
      <Card className="p-6 text-sm text-muted-foreground">
        Battle stats and match history are coming soon.
      </Card>
    </div>
  );
}
