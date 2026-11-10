'use client';

import { Alert, Badge, Button, Card, Skeleton } from '@cb/ui';
import { FileCode2, Plus } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/people';
import { messageFor } from '@/lib/api';
import { useAdminProblems } from '@/lib/problems';
import { DifficultyBadge, StatusBadge } from './problem-badges';

export function ProblemsList() {
  const q = useAdminProblems();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Problems</h1>
          <p className="mt-1 text-muted-foreground">
            Write a statement, upload test files, add reference solutions, calibrate, publish.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/problems/new">
            <Plus aria-hidden /> New problem
          </Link>
        </Button>
      </div>

      {q.isError ? (
        <Alert variant="destructive">{messageFor(q.error)}</Alert>
      ) : q.isPending ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<FileCode2 aria-hidden />} title="No problems yet">
          Create the first one. It stays a draft until it is calibrated and published.
        </EmptyState>
      ) : (
        <Card className="divide-y divide-border">
          {items.map((p) => (
            <Link
              key={p.id}
              href={`/admin/problems/${p.id}`}
              className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.title}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{p.slug}</p>
              </div>
              <DifficultyBadge difficulty={p.difficulty} />
              <StatusBadge status={p.status} />
              <Badge variant="secondary">v{p.version}</Badge>
            </Link>
          ))}
        </Card>
      )}
      {q.hasNextPage && (
        <Button
          variant="outline"
          className="justify-self-center"
          loading={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
