'use client';

import type { OnlinePlayer, PresenceStatus } from '@cb/contracts';
import { Badge, Button, Card, CardContent, Input, Skeleton, UserAvatar } from '@cb/ui';
import { Search, Swords, Users, X } from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { notify } from '@/components/battle-global';
import { EmptyState } from '@/components/people';
import { isApiError, messageFor } from '@/lib/api';
import {
  useAnswerChallenge,
  useChallenge,
  useLive,
  useOnlineCount,
  useOnlinePlayers,
  useOutgoingChallenges,
} from '@/lib/battle';
import { useRealtimeStatus } from '@/lib/realtime';
import { useMe, useRequireAuth } from '@/lib/session';

const STATUS: Record<PresenceStatus, { label: string; dot: string }> = {
  online: { label: 'Online', dot: 'bg-success' },
  in_match: { label: 'In a match', dot: 'bg-warning' },
  offline: { label: 'Offline', dot: 'bg-muted-foreground' },
};

function Dot({ status }: { status: PresenceStatus }) {
  return <span className={`inline-block size-2 rounded-full ${STATUS[status].dot}`} aria-hidden />;
}

function ChallengeButton({ userId, status }: { userId: string; status: PresenceStatus }) {
  const { data: me } = useMe();
  const challenge = useChallenge();
  const outgoing = useOutgoingChallenges(!!me);
  const pending = outgoing.data?.some((c) => c.to.id === userId);
  if (me?.id === userId) return <Badge variant="secondary">You</Badge>;
  return (
    <Button
      size="sm"
      disabled={status !== 'online' || pending || !me?.emailVerified}
      loading={challenge.isPending}
      title={
        !me?.emailVerified
          ? 'Verify your email to play'
          : status === 'in_match'
            ? 'Already in a match'
            : undefined
      }
      onClick={() =>
        challenge.mutate(userId, {
          onError: (e) =>
            notify(
              isApiError(e, 'OPPONENT_OFFLINE')
                ? 'They just went offline.'
                : isApiError(e, 'USER_IN_ACTIVE_MATCH')
                  ? e.message
                  : messageFor(e),
            ),
        })
      }
    >
      {!challenge.isPending && <Swords aria-hidden />} {pending ? 'Challenged' : 'Challenge'}
    </Button>
  );
}

function PlayerRow({
  p,
}: {
  p: { userId: string; username: string; fullname: string; avatarUrl: string | null; status: PresenceStatus };
}) {
  return (
    <li className="flex items-center gap-3 py-3">
      <UserAvatar name={p.fullname} src={p.avatarUrl} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{p.username}</p>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Dot status={p.status} /> {STATUS[p.status].label}
        </p>
      </div>
      <ChallengeButton userId={p.userId} status={p.status} />
    </li>
  );
}

function Countdown({ until }: { until: string }) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.ceil((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [until]);
  return <span className="tabular-nums">{left}s</span>;
}

function Outgoing() {
  const { data: me } = useMe();
  const outgoing = useOutgoingChallenges(!!me);
  const answer = useAnswerChallenge();
  const items = outgoing.data ?? [];
  if (!items.length) return null;
  return (
    <Card>
      <CardContent className="grid gap-2 pt-6">
        <h2 className="font-semibold">Waiting for an answer</h2>
        <ul className="divide-y divide-border">
          {items.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <UserAvatar name={c.to.fullname} src={c.to.avatarUrl} size="sm" />
              <span className="flex-1 truncate">{c.to.username}</span>
              <Countdown until={c.expiresAt} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => answer.mutate({ id: c.id, action: 'cancel' })}
                aria-label={`Cancel the challenge to ${c.to.username}`}
              >
                <X aria-hidden /> Cancel
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function LobbyView() {
  useRequireAuth();
  const friends = useLive((s) => s.friends);
  const socket = useRealtimeStatus();
  const [q, setQ] = useState('');
  const prefix = useDeferredValue(q.trim());
  const players = useOnlinePlayers(prefix);
  const count = useOnlineCount();
  const onlineFriends = friends.filter((f) => f.status !== 'offline');
  const list: OnlinePlayer[] = players.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Lobby</h1>
          <p className="mt-1 text-muted-foreground">Challenge someone online to a 30-minute battle.</p>
        </div>
        <Badge variant={socket === 'connected' ? 'success' : 'secondary'} aria-live="polite">
          {socket === 'connected' ? `${count.data ?? '…'} online` : 'Connecting…'}
        </Badge>
      </div>

      <Outgoing />

      <Card>
        <CardContent className="pt-6">
          <h2 className="font-semibold">Friends online</h2>
          {onlineFriends.length ? (
            <ul className="divide-y divide-border">
              {onlineFriends.map((f) => (
                <PlayerRow key={f.userId} p={f} />
              ))}
            </ul>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              {friends.length
                ? 'None of your friends are online right now.'
                : 'Add friends to see them here.'}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Players online</h2>
            <div className="relative w-full sm:w-64">
              <Search
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by username"
                aria-label="Search online players by username"
                className="pl-9"
              />
            </div>
          </div>
          {players.isPending ? (
            <div className="grid gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : list.length ? (
            <ul className="divide-y divide-border">
              {list.map((p) => (
                <PlayerRow key={p.userId} p={p} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Users aria-hidden />}
              title={prefix ? 'Nobody online by that name' : 'Nobody else is online'}
            >
              Invite a friend, or check back in a bit.
            </EmptyState>
          )}
          {players.hasNextPage && (
            <Button
              variant="outline"
              className="justify-self-center"
              loading={players.isFetchingNextPage}
              onClick={() => void players.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
