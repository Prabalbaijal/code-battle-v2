'use client';

import { Alert, Button } from '@cb/ui';
import { GraduationCap, Loader2, MessagesSquare, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useAiStatus, useRequestReview, useReview } from '@/lib/ai';
import { messageFor } from '@/lib/api';

/**
 * Post-match coach (plan §22.2 #1), on the end screen. Opt-in: asking starts a review in the
 * background; the panel polls until it's written. Loaded lazily (it isn't part of the battle bundle).
 */
export function CoachReview({
  matchId,
  failedSubmissionId,
}: {
  matchId: string;
  failedSubmissionId?: string;
}) {
  const status = useAiStatus();
  const review = useReview(matchId, status.data?.features.review === true);
  const ask = useRequestReview(matchId);
  if (!status.data?.features.review) return null;

  const r = review.data;
  const tutorLink = status.data.features.tutor && failedSubmissionId && (
    <Button asChild variant="ghost" size="sm">
      <Link href={`/tutor?submission=${failedSubmissionId}`}>
        <MessagesSquare aria-hidden /> Ask the tutor why it failed
      </Link>
    </Button>
  );

  if (!r || r.status === 'failed') {
    return (
      <div className="grid justify-items-center gap-2">
        {r?.status === 'failed' && <p className="text-sm text-muted-foreground">{r.error}</p>}
        {ask.isError && <p className="text-sm text-destructive">{messageFor(ask.error)}</p>}
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" size="sm" loading={ask.isPending} onClick={() => ask.mutate()}>
            {!ask.isPending && <Sparkles aria-hidden />}{' '}
            {r?.status === 'failed' ? 'Try the review again' : 'AI coach review'}
          </Button>
          {tutorLink}
        </div>
      </div>
    );
  }
  if (r.status === 'pending') {
    return (
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Your coach is reading the code…
      </p>
    );
  }
  const v = r.review!;
  return (
    <section
      aria-label="AI coach review"
      className="grid max-h-[45vh] gap-3 overflow-y-auto rounded-lg border border-border bg-muted/40 p-4 text-left text-sm"
    >
      <h3 className="flex items-center gap-2 font-semibold">
        <GraduationCap className="size-4 text-primary" aria-hidden /> Coach review
      </h3>
      <p>{v.summary}</p>
      <p>
        <span className="font-medium">Verdict: </span>
        {v.verdictExplanation}
      </p>
      <p className="text-muted-foreground">
        Time {v.complexity.time} · Memory {v.complexity.space}
      </p>
      {v.issues.length > 0 && (
        <div>
          <p className="font-medium">What to fix</p>
          <ul className="mt-1 grid list-disc gap-1 pl-5">
            {v.issues.map((i, n) => (
              <li key={n}>
                <span className="font-medium">{i.title}:</span> {i.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p>
        <span className="font-medium">A better approach: </span>
        {v.betterApproach}
      </p>
      {v.comparison && (
        <p>
          <span className="font-medium">Your opponent: </span>
          {v.comparison}
        </p>
      )}
      {v.tips.length > 0 && (
        <div>
          <p className="font-medium">Tips</p>
          <ul className="mt-1 grid list-disc gap-1 pl-5">
            {v.tips.map((t, n) => (
              <li key={n}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <Alert className="text-xs">
        AI-written: it can be wrong. Your code was never shown to your opponent.
      </Alert>
      {tutorLink}
    </section>
  );
}
