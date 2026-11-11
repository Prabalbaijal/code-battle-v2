'use client';

import type { LeaderboardEntry, PresenceStatus } from '@cb/contracts';
import {
  Alert,
  Badge,
  Card,
  cn,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  UserAvatar,
} from '@cb/ui';
import { Coins, Trophy, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/people';
import { messageFor } from '@/lib/api';
import { useLeaderboard, usePresence } from '@/lib/rating';
import { useMe } from '@/lib/session';

export function LeaderboardView() {
  const { data: me } = useMe();
  const [scope, setScope] = useState<'global' | 'friends'>('global');

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Leaderboard</h1>
        <p className="text-sm text-muted-foreground">Ranked by coins. Ties go to whoever got there first.</p>
      </div>
      {me ? (
        <Tabs value={scope} onValueChange={(v) => setScope(v as 'global' | 'friends')} className="grid gap-4">
          <TabsList aria-label="Leaderboard scope">
            <TabsTrigger value="global">Everyone</TabsTrigger>
            <TabsTrigger value="friends">Friends</TabsTrigger>
          </TabsList>
          <TabsContent value="global">
            <Board scope="global" meId={me.id} />
          </TabsContent>
          <TabsContent value="friends">
            <Board scope="friends" meId={me.id} />
          </TabsContent>
        </Tabs>
      ) : (
        <Board scope="global" meId={null} />
      )}
    </div>
  );
}

function Board({ scope, meId }: { scope: 'global' | 'friends'; meId: string | null }) {
  const board = useLeaderboard(scope);
  const ids = board.data?.items.map((i) => i.userId) ?? [];
  const presence = usePresence(ids, !!meId);

  if (board.isPending) {
    return (
      <Card className="grid gap-3 p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </Card>
    );
  }
  if (board.isError) return <Alert variant="destructive">{messageFor(board.error)}</Alert>;

  const { items, me } = board.data;
  const meListed = items.some((i) => i.userId === meId);
  return (
    <div className="grid gap-3">
      {me && !meListed && (
        <Card className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
          <span>
            Your rank: <strong>{me.rank === null ? 'not ranked' : `#${me.rank}`}</strong>
          </span>
          <span className="flex items-center gap-1.5 tabular-nums">
            <Coins className="size-4 text-warning" aria-hidden /> {me.coins} · Level {me.level}
          </span>
        </Card>
      )}
      {items.length === 0 ? (
        <EmptyState icon={<Users />} title={scope === 'friends' ? 'No friends yet' : 'No players yet'}>
          {scope === 'friends' ? 'Add friends to see how you stack up.' : 'Be the first to play a match.'}
        </EmptyState>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">
              {scope === 'friends' ? 'You and your friends' : 'Top 50 players'} by coins
            </caption>
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="w-14 px-4 py-2 text-right">
                  #
                </th>
                <th scope="col" className="px-2 py-2">
                  Player
                </th>
                <th scope="col" className="hidden px-2 py-2 text-right sm:table-cell">
                  W / L
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  Level
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  Coins
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <Row key={e.userId} e={e} isMe={e.userId === meId} status={presence.data?.[e.userId]} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {board.data.fallback && (
        <p className="text-xs text-muted-foreground">Served from the database while the cache recovers.</p>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<PresenceStatus, string> = {
  online: 'Online',
  in_match: 'In a match',
  offline: 'Offline',
};

function Row({
  e,
  isMe,
  status,
}: {
  e: LeaderboardEntry;
  isMe: boolean;
  status: PresenceStatus | undefined;
}) {
  return (
    <tr className={cn('border-b border-border last:border-0', isMe && 'bg-primary/10')}>
      <td className="px-4 py-2 text-right font-semibold tabular-nums">
        {e.rank <= 3 ? (
          <span className="inline-flex items-center gap-1">
            <Trophy
              className={cn('size-4', e.rank === 1 ? 'text-warning' : 'text-muted-foreground')}
              aria-hidden
            />
            {e.rank}
          </span>
        ) : (
          e.rank
        )}
      </td>
      <td className="px-2 py-2">
        <Link href={`/u/${e.username}`} className="flex min-w-0 items-center gap-3 hover:underline">
          <span className="relative shrink-0">
            <UserAvatar name={e.fullname || e.username} src={e.avatarUrl} size="sm" />
            {status && status !== 'offline' && (
              <span
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-card',
                  status === 'in_match' ? 'bg-warning' : 'bg-success',
                )}
                title={STATUS_TEXT[status]}
              />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium">
              {e.username}
              {isMe && <span className="text-muted-foreground"> (you)</span>}
            </span>
            {status && status !== 'offline' && <span className="sr-only">{STATUS_TEXT[status]}</span>}
          </span>
        </Link>
      </td>
      <td className="hidden px-2 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
        {e.wins} / {e.losses}
      </td>
      <td className="px-2 py-2 text-right">
        <Badge variant="secondary">L{e.level}</Badge>
      </td>
      <td className="px-4 py-2 text-right font-semibold tabular-nums">{e.coins}</td>
    </tr>
  );
}
