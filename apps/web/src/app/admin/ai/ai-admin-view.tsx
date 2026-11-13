'use client';

import type { IntegrityFlag } from '@cb/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@cb/ui';
import { ShieldAlert, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/people';
import { useAiFlags, useAiUsage, useReviewFlag } from '@/lib/ai';
import { messageFor } from '@/lib/api';
import { isAdmin } from '@/lib/judge';
import { useMe } from '@/lib/session';

const pct = (used: number, limit: number) => Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));

function Usage() {
  const q = useAiUsage();
  if (q.isError) return <Alert variant="destructive">{messageFor(q.error)}</Alert>;
  if (!q.data) return <Skeleton className="h-32 w-full" />;
  return (
    <Card>
      <CardContent className="grid gap-4 p-5">
        <h2 className="font-semibold">Today’s AI allowance ({q.data.day}, UTC)</h2>
        {q.data.models.map((m) => (
          <div key={m.model} className="grid gap-1 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-mono text-xs">{m.model}</span>
              <span className="tabular-nums text-muted-foreground">
                {m.tokensUsed.toLocaleString()} / {m.tokensLimit.toLocaleString()} tokens · {m.requestsUsed} /{' '}
                {m.requestsLimit} requests
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label={`${m.model} tokens used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct(m.tokensUsed, m.tokensLimit)}
            >
              <div className="h-full bg-primary" style={{ width: `${pct(m.tokensUsed, m.tokensLimit)}%` }} />
            </div>
          </div>
        ))}
        {q.data.byFeature.length > 0 && (
          <table className="text-sm">
            <caption className="sr-only">Requests and tokens per feature today</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="font-normal">Feature</th>
                <th className="text-right font-normal">Requests</th>
                <th className="text-right font-normal">Tokens</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {q.data.byFeature.map((f) => (
                <tr key={f.feature}>
                  <td>{f.feature}</td>
                  <td className="text-right">{f.requests}</td>
                  <td className="text-right">{f.tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function FlagRow({ f }: { f: IntegrityFlag }) {
  const review = useReviewFlag();
  return (
    <li className="grid gap-2 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={f.similarity >= 0.9 ? 'destructive' : 'warning'}>
          {Math.round(f.similarity * 100)}% similar
        </Badge>
        <span>
          {f.relation === 'opponent' ? 'to the opponent’s code' : 'to an earlier accepted solution'}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(f.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        match {f.matchId.slice(0, 8)} · player {f.userId.slice(0, 8)} · other {f.otherUserId.slice(0, 8)}
      </p>
      {f.note && <p className="text-xs">Note: {f.note}</p>}
      {f.status === 'open' && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={review.isPending}
            onClick={() => review.mutate({ id: f.id, status: 'cleared' })}
          >
            Clear (honest)
          </Button>
          <Button
            size="sm"
            variant="destructive"
            loading={review.isPending}
            onClick={() => review.mutate({ id: f.id, status: 'confirmed' })}
          >
            Confirm copying
          </Button>
        </div>
      )}
      {review.isError && <p className="text-destructive">{messageFor(review.error)}</p>}
    </li>
  );
}

function Flags({ status }: { status: 'open' | 'cleared' | 'confirmed' }) {
  const q = useAiFlags(status);
  if (q.isError) return <Alert variant="destructive">{messageFor(q.error)}</Alert>;
  if (!q.data) return <Skeleton className="h-24 w-full" />;
  if (!q.data.length) return <p className="text-sm text-muted-foreground">Nothing here.</p>;
  return (
    <ul className="grid gap-2">
      {q.data.map((f) => (
        <FlagRow key={f.id} f={f} />
      ))}
    </ul>
  );
}

/** /admin/ai: the AI budget for today and anti-cheat flags waiting for a human decision. */
export function AiAdminView() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<'open' | 'cleared' | 'confirmed'>('open');
  if (me && !isAdmin(me)) {
    return (
      <EmptyState icon={<ShieldAlert aria-hidden />} title="Admins only">
        AI usage and integrity flags are visible to admins.
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Sparkles className="size-6 text-primary" aria-hidden /> AI
        </h1>
        <p className="text-sm text-muted-foreground">
          Free-tier usage and similarity flags. A flag is a signal for review, never an automatic penalty.
        </p>
      </div>
      <Usage />
      <section className="grid gap-3">
        <h2 className="font-semibold">Integrity flags</h2>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="grid gap-3">
          <TabsList aria-label="Flag status">
            <TabsTrigger value="open">Open</TabsTrigger>
            <TabsTrigger value="cleared">Cleared</TabsTrigger>
            <TabsTrigger value="confirmed">Confirmed</TabsTrigger>
          </TabsList>
          <TabsContent value={tab}>
            <Flags status={tab} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}
