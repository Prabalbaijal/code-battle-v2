'use client';

import type { AdminProblem } from '@cb/contracts';
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
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  Circle,
  FileText,
  FlaskConical,
  Gauge,
  Rocket,
  TestTubes,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { isApiError, messageFor } from '@/lib/api';
import { useAdminProblem, useArchive, usePublish, useUpdateProblem } from '@/lib/problems';
import { DifficultyBadge, StatusBadge } from '../problem-badges';
import { toUpdateBody } from '@/lib/problem-form';
import { StatementForm } from '../statement-form';
import { CalibrationPanel } from './calibration-panel';
import { ReferencesPanel } from './references-panel';
import { TestFilesPanel } from './test-files-panel';

const TABS = ['statement', 'tests', 'references', 'calibration'] as const;
type Tab = (typeof TABS)[number];

export function ProblemEditor({ id }: { id: string }) {
  const q = useAdminProblem(id);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'statement';
  const update = useUpdateProblem(id);

  if (q.isPending) return <Skeleton className="h-96 w-full" />;
  if (q.isError) {
    return (
      <Alert variant="destructive">
        {isApiError(q.error, 'NOT_FOUND') ? 'This problem does not exist.' : messageFor(q.error)}
      </Alert>
    );
  }
  const p = q.data;

  return (
    <div className="grid gap-6">
      <Header problem={p} />
      <PublishChecklist problem={p} />
      <Tabs value={tab} onValueChange={(t) => router.replace(`${pathname}?tab=${t}`, { scroll: false })}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="statement">
            <FileText className="size-4" aria-hidden /> Statement
          </TabsTrigger>
          <TabsTrigger value="tests">
            <TestTubes className="size-4" aria-hidden /> Tests
            <Badge variant="secondary" className="ml-1 px-1.5">
              {p.testFiles.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="references">
            <FlaskConical className="size-4" aria-hidden /> References
            <Badge variant="secondary" className="ml-1 px-1.5">
              {p.referenceSolutions.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="calibration">
            <Gauge className="size-4" aria-hidden /> Calibration
          </TabsTrigger>
        </TabsList>
        <TabsContent value="statement">
          <StatementForm
            initial={p}
            submitLabel="Save statement"
            onSubmit={(values, changed) => update.mutateAsync(toUpdateBody(values, changed))}
          />
        </TabsContent>
        <TabsContent value="tests">
          <TestFilesPanel problem={p} />
        </TabsContent>
        <TabsContent value="references">
          <ReferencesPanel problem={p} />
        </TabsContent>
        <TabsContent value="calibration">
          <CalibrationPanel problem={p} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Header({ problem: p }: { problem: AdminProblem }) {
  const publish = usePublish(p.id);
  const archive = useArchive(p.id);
  const [error, setError] = useState<string | null>(null);
  const run = (m: typeof publish) => {
    setError(null);
    m.mutate(undefined, { onError: (e) => setError(messageFor(e)) });
  };

  return (
    <div className="grid gap-3">
      <Link
        href="/admin/problems"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Problems
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight break-words">{p.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={p.status} />
            <DifficultyBadge difficulty={p.difficulty} />
            <span className="font-mono">{p.slug}</span>
            <span aria-hidden>·</span>
            <span>version {p.version}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.status !== 'archived' && (
            <Button
              variant="outline"
              loading={archive.isPending}
              onClick={() => {
                if (window.confirm('Archive this problem? It will no longer be picked for battles.'))
                  run(archive);
              }}
            >
              {!archive.isPending && <Archive aria-hidden />} Archive
            </Button>
          )}
          {p.status !== 'published' && (
            <Button
              loading={publish.isPending}
              disabled={p.publishBlockers.length > 0}
              onClick={() => run(publish)}
            >
              {!publish.isPending && <Rocket aria-hidden />} Publish
            </Button>
          )}
        </div>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
    </div>
  );
}

/** The server's own publish rules (`publishBlockers`), shown as a checklist. */
function PublishChecklist({ problem: p }: { problem: AdminProblem }) {
  if (p.status === 'published' || p.publishBlockers.length === 0) {
    if (p.status === 'published') return null;
    return (
      <Alert variant="success">
        <CheckCircle2 aria-hidden />
        <div>Everything is ready. Publish to make it available in battles.</div>
      </Alert>
    );
  }
  return (
    <Card>
      <CardContent className="grid gap-2 pt-6">
        <p className="text-sm font-medium">Before publishing</p>
        <ul className="grid gap-1.5 text-sm" aria-label="Publish blockers">
          {p.publishBlockers.map((b) => (
            <li key={b.code} className="flex items-start gap-2">
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{b.message}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
