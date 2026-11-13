'use client';

import type { Recommendations } from '@cb/contracts';
import { Badge, Button, Card, CardContent, Skeleton } from '@cb/ui';
import { BookOpen, MessagesSquare, Target } from 'lucide-react';
import Link from 'next/link';
import { useAiStatus, useNotes, useRecommendations } from '@/lib/ai';
import { useMe } from '@/lib/session';

const VERDICT_WORD: Record<string, string> = {
  WA: 'wrong answers',
  TLE: 'time limits',
  RE: 'runtime errors',
  MLE: 'memory limits',
  CE: 'compile errors',
};

function ForYou({ rec }: { rec: Recommendations }) {
  if (!rec.weak.length && !rec.strong.length) return null;
  return (
    <Card>
      <CardContent className="grid gap-3 p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Target className="size-4 text-primary" aria-hidden />
          {rec.basis === 'history' ? 'Practise next' : 'Start here'}
        </h2>
        {rec.basis === 'history' ? (
          <p className="text-sm text-muted-foreground">
            From your own submissions: the topics where you lose most.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Play a few matches and this list adapts to you.</p>
        )}
        <ul className="grid gap-3">
          {rec.weak.map((t) => (
            <li key={t.tag} className="grid gap-1">
              <p className="text-sm">
                <span className="font-medium">{t.tag}</span>
                {t.attempts > 0 && (
                  <span className="text-muted-foreground">
                    {' '}
                    · unsolved {t.failed} of {t.attempts}
                    {t.commonVerdict &&
                      VERDICT_WORD[t.commonVerdict] &&
                      `, mostly ${VERDICT_WORD[t.commonVerdict]}`}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {t.notes.map((n) => (
                  <Link
                    key={n.slug}
                    href={`/learn/${n.slug}`}
                    className="text-sm text-primary hover:underline"
                  >
                    {n.title}
                  </Link>
                ))}
              </div>
            </li>
          ))}
        </ul>
        {rec.strong.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Strong:{' '}
            {rec.strong.map((s) => (
              <Badge key={s} variant="secondary" className="mr-1">
                {s}
              </Badge>
            ))}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** /learn: the DSA notes (the tutor's sources), and recommendations for signed-in players. */
export function LearnView() {
  const { data: me } = useMe();
  const status = useAiStatus();
  const notes = useNotes();
  const rec = useRecommendations(!!me && status.data?.features.recommendations === true);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Learn</h1>
          <p className="text-sm text-muted-foreground">Short notes on the ideas battles keep testing.</p>
        </div>
        {me && status.data?.features.tutor && (
          <Button asChild>
            <Link href="/tutor">
              <MessagesSquare aria-hidden /> Ask the tutor
            </Link>
          </Button>
        )}
      </div>
      {rec.data && <ForYou rec={rec.data} />}
      {notes.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {(notes.data ?? []).map((n) => (
            <li key={n.slug}>
              <Link
                href={`/learn/${n.slug}`}
                className="flex h-full items-start gap-3 rounded-lg border border-border p-4 transition-colors hover:bg-muted"
              >
                <BookOpen className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="grid gap-1">
                  <span className="font-medium">{n.title}</span>
                  <span className="text-xs text-muted-foreground">{n.tags.join(' · ')}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
