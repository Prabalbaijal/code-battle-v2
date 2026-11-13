'use client';

import type { LanguageKey } from '@cb/contracts';
import { Button, cn } from '@cb/ui';
import { Coins, Lightbulb, Lock } from 'lucide-react';
import { useState } from 'react';
import { LazyMarkdown as Markdown } from '@/components/lazy-markdown';
import { useAiStatus, useGetHint, useHints } from '@/lib/ai';
import { messageFor } from '@/lib/api';

const LEVEL_NAME = ['A nudge', 'The approach', 'An outline'];

/**
 * Progressive hints (plan §22.2 #2) in the battle room's console. In a match each level costs
 * coins (asked once, then shown again for free); level n opens after n − 1. Loaded lazily.
 */
export function HintsPanel({
  problemId,
  matchId,
  code,
  language,
}: {
  problemId: string;
  matchId: string | null;
  code: string;
  language: LanguageKey;
}) {
  const status = useAiStatus();
  const hints = useHints(problemId);
  const get = useGetHint();
  const [confirming, setConfirming] = useState<number | null>(null);

  if (status.isPending || hints.isPending) return <p className="text-muted-foreground">Loading hints…</p>;
  if (!status.data?.features.hints) {
    return <p className="text-muted-foreground">Hints aren’t available on this server.</p>;
  }
  const costs = status.data.hintCosts;
  const have = hints.data ?? [];
  const next = have.length + 1;

  const open = (level: number) => {
    setConfirming(null);
    get.mutate({
      problemId,
      level,
      ...(matchId ? { matchId } : {}),
      code: code.slice(0, 16_000),
      languageKey: language,
    });
  };

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Hints point you in the right direction without giving the answer away.
        {matchId && ' In a battle they cost coins.'}
      </p>
      <ol className="grid gap-2">
        {have.map((h) => (
          <li key={h.level} className="rounded-md border border-border p-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Hint {h.level}: {LEVEL_NAME[h.level - 1]}
            </p>
            <Markdown className="text-sm">{h.text}</Markdown>
          </li>
        ))}
      </ol>
      {next <= 3 && (
        <div className="flex flex-wrap items-center gap-2">
          {confirming === next ? (
            <>
              <span className="text-sm">
                Spend <span className="font-semibold">{costs[next - 1]} coins</span> on hint {next}?
              </span>
              <Button size="sm" onClick={() => open(next)}>
                Yes, show it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={get.isPending}
              onClick={() => (matchId && costs[next - 1]! > 0 ? setConfirming(next) : open(next))}
            >
              {!get.isPending && <Lightbulb aria-hidden />} Hint {next}: {LEVEL_NAME[next - 1]}
              {matchId && costs[next - 1]! > 0 && (
                <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                  <Coins className="size-3" aria-hidden /> {costs[next - 1]}
                </span>
              )}
            </Button>
          )}
          {next < 3 && (
            <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground')}>
              <Lock className="size-3" aria-hidden /> Hint {next + 1} opens after this one
            </span>
          )}
        </div>
      )}
      {get.isError && (
        <p className="text-sm text-destructive" role="alert">
          {messageFor(get.error)}
        </p>
      )}
      {get.data?.charged ? (
        <p className="text-xs text-muted-foreground" role="status">
          −{get.data.charged} coins{get.data.coins !== null && ` · ${get.data.coins} left`}
        </p>
      ) : null}
    </div>
  );
}
