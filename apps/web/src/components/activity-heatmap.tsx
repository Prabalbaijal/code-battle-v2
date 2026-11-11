'use client';

import type { LedgerEntry } from '@cb/contracts';
import { cn } from '@cb/ui';
import { useMemo, useState } from 'react';

const WEEKS = 12;
const DAY = 86_400_000;
/** One hue, light → dark (sequential): more matches, stronger primary. */
const STEPS = ['bg-muted', 'bg-primary/30', 'bg-primary/55', 'bg-primary/80', 'bg-primary'];
const step = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 3 : 4);
const key = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (d: Date) => d.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * Matches per day over the last 12 weeks (plan §21.5), from the coin ledger (one row per finished
 * match). Columns are weeks, rows Monday → Sunday, newest on the right. Hover a day for its count.
 * The grid itself is decorative for assistive tech: they get the summary and the list of active days.
 */
export function ActivityHeatmap({ entries }: { entries: LedgerEntry[] }) {
  const [active, setActive] = useState<{ date: Date; n: number } | null>(null);
  const { weeks, total, days } = useMemo(() => {
    const perDay = new Map<string, number>();
    for (const e of entries) {
      if (!e.matchId) continue; // the signup bonus isn't a match
      const k = e.createdAt.slice(0, 10);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const mondayOffset = (today.getUTCDay() + 6) % 7;
    const start = new Date(today.getTime() - (mondayOffset + (WEEKS - 1) * 7) * DAY);
    const cols: { date: Date; n: number; future: boolean }[][] = [];
    let sum = 0;
    let active = 0;
    for (let w = 0; w < WEEKS; w++) {
      const col = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start.getTime() + (w * 7 + d) * DAY);
        const n = perDay.get(key(date)) ?? 0;
        const future = date > today;
        if (!future) {
          sum += n;
          if (n) active++;
        }
        col.push({ date, n, future });
      }
      cols.push(col);
    }
    return { weeks: cols, total: sum, days: active };
  }, [entries]);

  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">
        {active
          ? `${fmt(active.date)}: ${active.n} ${active.n === 1 ? 'match' : 'matches'}`
          : `${total} ${total === 1 ? 'match' : 'matches'} on ${days} ${days === 1 ? 'day' : 'days'} in the last ${WEEKS} weeks`}
      </p>
      <div className="flex gap-[3px]" aria-hidden>
        {weeks.map((col, i) => (
          <div key={i} className="grid gap-[3px]">
            {col.map((c) => (
              <span
                key={key(c.date)}
                className={cn(
                  'size-3 rounded-[3px] sm:size-3.5',
                  c.future ? 'bg-transparent' : STEPS[step(c.n)],
                )}
                onMouseEnter={() => !c.future && setActive(c)}
                onMouseLeave={() => setActive(null)}
              />
            ))}
          </div>
        ))}
      </div>
      <ul className="sr-only">
        {weeks
          .flat()
          .filter((c) => c.n > 0 && !c.future)
          .map((c) => (
            <li key={key(c.date)}>
              {fmt(c.date)}: {c.n} {c.n === 1 ? 'match' : 'matches'}
            </li>
          ))}
      </ul>
      <div className="flex items-center gap-1 text-xs text-muted-foreground" aria-hidden>
        Less
        {STEPS.map((s) => (
          <span key={s} className={cn('size-3 rounded-[3px]', s)} />
        ))}
        More
      </div>
    </div>
  );
}
