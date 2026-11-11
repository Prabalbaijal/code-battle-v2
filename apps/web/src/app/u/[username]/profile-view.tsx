'use client';

import type { HistoryItem, PlayerStats, ProfilePageView } from '@cb/contracts';
import { Alert, Badge, Button, Card, cn, Skeleton, UserAvatar } from '@cb/ui';
import { CalendarDays, Coins, Flame, Swords, UserX } from 'lucide-react';
import Link from 'next/link';
import { LazyActivityHeatmap } from '@/components/lazy-activity';
import { LazyCoinChart as CoinChart } from '@/components/lazy-coin-chart';
import { ResultDonut } from '@/components/result-donut';
import { EmptyState, RelationshipActions } from '@/components/people';
import { isApiError, messageFor } from '@/lib/api';
import { signed, useCoinHistory, useHistory, useProfilePage } from '@/lib/rating';

export function ProfileView({ username, initial }: { username: string; initial?: ProfilePageView | null }) {
  const page = useProfilePage(username, initial);

  if (page.isPending) {
    return (
      <div className="grid gap-6">
        <Card className="flex items-center gap-5 p-6">
          <Skeleton className="size-20 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </Card>
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (page.isError) {
    return isApiError(page.error, 'NOT_FOUND') ? (
      <EmptyState icon={<UserX />} title="Player not found">
        No one goes by @{username}.
      </EmptyState>
    ) : (
      <Alert variant="destructive">{messageFor(page.error)}</Alert>
    );
  }

  const { profile: p, stats, isMe, history } = page.data;
  const joined = new Date(p.createdAt).toLocaleDateString('en', { month: 'long', year: 'numeric' });
  return (
    <div className="grid min-w-0 gap-6">
      <Card className="flex min-w-0 flex-col gap-5 p-6 sm:flex-row sm:items-center">
        <UserAvatar name={p.fullname} src={p.avatarUrl} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-2xl font-bold tracking-tight">
            {p.fullname}
            {stats && <Badge>Level {stats.level}</Badge>}
          </h1>
          <p className="text-muted-foreground">@{p.username}</p>
          {p.bio && <p className="mt-2 max-w-prose text-sm">{p.bio}</p>}
          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDays className="size-3.5" aria-hidden /> Joined {joined}
          </p>
        </div>
        {p.relationship && <RelationshipActions user={p} relationship={p.relationship} />}
      </Card>

      {stats ? (
        <>
          <StatTiles stats={stats} />
          {stats.wins + stats.losses + stats.draws > 0 && (
            <div className={cn('grid gap-6', isMe && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]')}>
              <Card className="grid min-w-0 content-start gap-3 p-6">
                <h2 className="font-semibold">Results</h2>
                <ResultDonut wins={stats.wins} losses={stats.losses} draws={stats.draws} />
              </Card>
              {isMe && (
                <Card className="grid min-w-0 content-start gap-3 p-6">
                  <h2 className="font-semibold">Activity</h2>
                  <MyActivity />
                </Card>
              )}
            </div>
          )}
        </>
      ) : (
        <Alert variant="warning">Battle stats are unavailable right now. Try again in a moment.</Alert>
      )}

      {isMe && (
        <>
          <Card className="grid min-w-0 gap-3 p-6">
            <h2 className="font-semibold">Coins over time</h2>
            {stats && stats.wins + stats.losses + stats.draws === 0 ? (
              // known from the server render: no need to wait for the ledger to say so
              <p className="text-sm text-muted-foreground">Play a match to start your coin history.</p>
            ) : (
              <MyCoinChart />
            )}
          </Card>
          <Card className="grid min-w-0 gap-3 p-6">
            <h2 className="font-semibold">Match history</h2>
            <History first={history} />
          </Card>
        </>
      )}
    </div>
  );
}

function StatTiles({ stats: s }: { stats: PlayerStats }) {
  const played = s.wins + s.losses + s.draws;
  const rate = played ? Math.round((s.wins / played) * 100) : null;
  const tiles = [
    { label: 'Coins', value: s.coins, icon: <Coins className="size-4 text-warning" aria-hidden /> },
    {
      label: 'Matches',
      value: played,
      icon: <Swords className="size-4 text-muted-foreground" aria-hidden />,
    },
    {
      label: 'Win rate',
      value: rate === null ? '—' : `${rate}%`,
      sub: `${s.wins}W · ${s.losses}L · ${s.draws}D`,
    },
    {
      label: 'Win streak',
      value: s.streak,
      sub: `Best ${s.bestStreak}`,
      icon: <Flame className="size-4 text-destructive" aria-hidden />,
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label} className="grid gap-1 p-4">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t.icon}
            {t.label}
          </dt>
          <dd className="text-2xl font-bold tabular-nums">{t.value}</dd>
          {t.sub && <dd className="text-xs text-muted-foreground">{t.sub}</dd>}
        </Card>
      ))}
    </dl>
  );
}

function MyCoinChart() {
  const ledger = useCoinHistory(true);
  if (ledger.isPending) return <Skeleton className="h-48" />;
  if (ledger.isError)
    return <p className="text-sm text-muted-foreground">Coin history is unavailable right now.</p>;
  return <CoinChart entries={ledger.data} />;
}

function MyActivity() {
  const ledger = useCoinHistory(true);
  if (ledger.isPending) return <Skeleton className="h-28" />;
  if (ledger.isError)
    return <p className="text-sm text-muted-foreground">Activity is unavailable right now.</p>;
  return <LazyActivityHeatmap entries={ledger.data} />;
}

/** The BFF's first 10, then older pages on demand. */
function History({ first }: { first: { items: HistoryItem[]; nextCursor: string | null } | null }) {
  const more = useHistory(false);
  if (!first) return <p className="text-sm text-muted-foreground">Match history is unavailable right now.</p>;
  if (!first.items.length)
    return <p className="text-sm text-muted-foreground">No matches yet. Challenge someone from the lobby!</p>;

  // the infinite query starts from the beginning; once loaded it replaces the first page
  const items = more.data ? more.data.pages.flatMap((pg) => pg.items) : first.items;
  const next = more.data ? more.hasNextPage : !!first.nextCursor;
  return (
    <div className="grid gap-3">
      <ul className="divide-y divide-border">
        {items.map((m) => (
          <HistoryRow key={m.matchId} m={m} />
        ))}
      </ul>
      {next && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-center"
          loading={more.isFetching}
          onClick={() => (more.data ? void more.fetchNextPage() : void more.refetch())}
        >
          Show more
        </Button>
      )}
    </div>
  );
}

const RESULT: Record<string, { text: string; variant: 'success' | 'destructive' | 'secondary' }> = {
  win: { text: 'Won', variant: 'success' },
  loss: { text: 'Lost', variant: 'destructive' },
  draw: { text: 'Draw', variant: 'secondary' },
};

function HistoryRow({ m }: { m: HistoryItem }) {
  const r = m.result ? RESULT[m.result] : null;
  const when = m.endedAt ?? m.startedAt;
  const how =
    m.status === 'aborted'
      ? 'Aborted'
      : m.endReason === 'forfeit'
        ? 'Forfeit'
        : m.endReason === 'timeout'
          ? "Time's up"
          : m.endReason === 'solved'
            ? 'Solved'
            : m.status === 'completed'
              ? ''
              : 'In progress';
  return (
    <li className="flex items-center gap-3 py-3 text-sm">
      {r ? <Badge variant={r.variant}>{r.text}</Badge> : <Badge variant="secondary">{how || '—'}</Badge>}
      <div className="min-w-0 flex-1">
        <div className="truncate">
          vs{' '}
          {m.opponent ? (
            <Link href={`/u/${m.opponent.username}`} className="font-medium hover:underline">
              @{m.opponent.username}
            </Link>
          ) : (
            'unknown'
          )}
          {m.problemSlug && <span className="text-muted-foreground"> · {m.problemSlug}</span>}
        </div>
        <div className="text-xs text-muted-foreground">
          {r && how ? `${how} · ` : ''}
          {when ? new Date(when).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }) : ''}
        </div>
      </div>
      <span
        className={cn(
          'w-14 text-right font-semibold tabular-nums',
          m.coinDelta === null
            ? 'text-muted-foreground'
            : m.coinDelta > 0
              ? 'text-success'
              : m.coinDelta < 0
                ? 'text-destructive'
                : 'text-muted-foreground',
        )}
        title={m.coinDelta === null ? 'Coin change unavailable' : 'Coins'}
      >
        {m.coinDelta === null ? '—' : signed(m.coinDelta)}
      </span>
    </li>
  );
}
