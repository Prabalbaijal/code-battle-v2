'use client';

import type { JudgeLevel } from '@cb/contracts';
import { Alert, Badge, Button, Card, CardContent, Skeleton } from '@cb/ui';
import { Gauge, ShieldAlert } from 'lucide-react';
import { EmptyState } from '@/components/people';
import { messageFor } from '@/lib/api';
import { isAdmin, useDriftCheck, useJudgeAdmin } from '@/lib/judge';
import { useMe } from '@/lib/session';

const LEVEL: Record<
  JudgeLevel,
  { label: string; hint: string; variant: 'success' | 'warning' | 'destructive' }
> = {
  normal: { label: 'Normal', hint: 'Everything is available.', variant: 'success' },
  no_custom_input: {
    label: 'No custom input',
    hint: 'Under 30% of today’s quota left: Runs with custom input are paused.',
    variant: 'warning',
  },
  runs_throttled: {
    label: 'Runs throttled',
    hint: 'Under 15% left: one Run per user per minute.',
    variant: 'warning',
  },
  no_new_matches: {
    label: 'No new matches',
    hint: 'Under 5% left: matches in progress can finish, no new ones start.',
    variant: 'destructive',
  },
};

export function JudgeView() {
  const { data: me } = useMe();
  const q = useJudgeAdmin();
  const check = useDriftCheck();

  if (me && !isAdmin(me)) {
    return (
      <EmptyState icon={<ShieldAlert aria-hidden />} title="Admins only">
        The judge’s quota and drift settings are visible to admins.
      </EmptyState>
    );
  }
  if (q.isError) return <Alert variant="destructive">{messageFor(q.error)}</Alert>;
  if (!q.data) return <Skeleton className="h-64 w-full" />;

  const { capacity: c, drift: d } = q.data;
  const level = LEVEL[c.level];
  const pct = c.limit ? Math.round((c.remaining / c.limit) * 100) : 0;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Judge</h1>
        <p className="mt-1 text-muted-foreground">Today’s Judge0 quota (UTC day) and time-limit drift.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="grid gap-3 pt-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">Quota</h2>
              <Badge variant={level.variant}>{level.label}</Badge>
            </div>
            <p className="text-3xl font-bold tabular-nums">
              {c.remaining.toLocaleString()}
              <span className="text-base font-normal text-muted-foreground">
                {' '}
                / {c.limit.toLocaleString()} requests left ({pct}%)
              </span>
            </p>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="meter"
              aria-label="Judge quota left"
              aria-valuemin={0}
              aria-valuemax={c.limit}
              aria-valuenow={c.remaining}
            >
              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-sm text-muted-foreground">{level.hint}</p>
            <p className="text-sm">
              Circuit breaker:{' '}
              <Badge variant={c.breaker === 'closed' ? 'secondary' : 'destructive'}>{c.breaker}</Badge>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-3 pt-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">Drift</h2>
              <Badge variant={d.factor === 1 ? 'secondary' : 'warning'}>× {d.factor.toFixed(2)}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Every CPU limit is multiplied by the factor. It changes only when the weekly benchmark is more
              than 20% away from the baseline (the first three checks).
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Checks</dt>
              <dd>{d.checks}</dd>
              <dt className="text-muted-foreground">Baseline</dt>
              <dd className="font-mono text-xs">
                {d.baseline
                  ? Object.entries(d.baseline)
                      .map(([k, v]) => `${k} ${v} ms`)
                      .join(' · ')
                  : 'after 3 checks'}
              </dd>
              <dt className="text-muted-foreground">Last check</dt>
              <dd className="text-xs">
                {d.lastCheck ? (
                  <>
                    {new Date(d.lastCheck.ranAt).toLocaleString()}
                    {d.lastCheck.error ? (
                      <span className="block text-destructive">{d.lastCheck.error}</span>
                    ) : (
                      <span className="block font-mono">
                        {Object.entries(d.lastCheck.samples ?? {})
                          .map(([k, v]) => `${k} ${v} ms`)
                          .join(' · ')}
                        {d.ratio !== null && ` (× ${d.ratio} of baseline)`}
                      </span>
                    )}
                  </>
                ) : (
                  'never'
                )}
              </dd>
            </dl>
            <Button
              variant="outline"
              className="justify-self-start"
              loading={check.isPending}
              disabled={check.isSuccess}
              onClick={() => check.mutate()}
            >
              {!check.isPending && <Gauge aria-hidden />}
              {check.isSuccess ? 'Check queued' : 'Run a check now'}
            </Button>
            <p className="text-xs text-muted-foreground">Uses one Judge0 request. Runs weekly by itself.</p>
            {check.isError && <Alert variant="destructive">{messageFor(check.error)}</Alert>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
