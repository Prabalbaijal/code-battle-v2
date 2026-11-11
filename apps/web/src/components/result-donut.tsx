'use client';

import { cn } from '@cb/ui';
import { useState } from 'react';

const R = 42;
const C = 2 * Math.PI * R;
const GAP = 3; // the surface gap between segments, in px of arc length

const PARTS = [
  { key: 'wins', label: 'Won', stroke: 'stroke-success', swatch: 'bg-success' },
  { key: 'losses', label: 'Lost', stroke: 'stroke-destructive', swatch: 'bg-destructive' },
  { key: 'draws', label: 'Draw', stroke: 'stroke-muted-foreground', swatch: 'bg-muted-foreground' },
] as const;

/**
 * Wins / losses / draws as a part-to-whole donut (plan §21.5). Identity is never colour alone: the
 * legend names every part with its count and share, and hovering or focusing a part puts it in
 * the centre. The win rate is the headline.
 */
export function ResultDonut({ wins, losses, draws }: { wins: number; losses: number; draws: number }) {
  const [active, setActive] = useState<(typeof PARTS)[number]['key'] | null>(null);
  const counts = { wins, losses, draws };
  const total = wins + losses + draws;
  if (!total) return <p className="text-sm text-muted-foreground">No matches yet.</p>;

  const pct = (n: number) => Math.round((n / total) * 100);
  let offset = 0;
  const arcs = PARTS.map((p) => {
    const len = (counts[p.key] / total) * C;
    const arc = { ...p, len: Math.max(0, len - (len > GAP * 2 ? GAP : 0)), offset };
    offset += len;
    return arc;
  }).filter((a) => counts[a.key] > 0);

  const focus = active ? PARTS.find((p) => p.key === active)! : null;
  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg
        viewBox="0 0 100 100"
        className="size-32 shrink-0 -rotate-90"
        role="img"
        aria-label={`${wins} won, ${losses} lost, ${draws} drawn: ${pct(wins)}% win rate`}
      >
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="10" className="stroke-muted" />
        {arcs.map((a) => (
          <circle
            key={a.key}
            cx="50"
            cy="50"
            r={R}
            fill="none"
            strokeWidth={active === a.key ? 12 : 10}
            className={cn(a.stroke, 'transition-[stroke-width] duration-150')}
            strokeDasharray={`${a.len} ${C - a.len}`}
            strokeDashoffset={-a.offset}
            onMouseEnter={() => setActive(a.key)}
            onMouseLeave={() => setActive(null)}
          />
        ))}
        <g className="rotate-90" style={{ transformOrigin: '50px 50px' }}>
          <text
            x="50"
            y="49"
            textAnchor="middle"
            className="fill-foreground text-[18px] font-bold tabular-nums"
          >
            {focus ? counts[focus.key] : `${pct(wins)}%`}
          </text>
          <text x="50" y="63" textAnchor="middle" className="fill-muted-foreground text-[9px]">
            {focus ? focus.label.toLowerCase() : 'win rate'}
          </text>
        </g>
      </svg>
      <ul className="grid gap-1.5 text-sm">
        {PARTS.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              className="flex items-center gap-2 rounded px-1 text-left hover:bg-muted"
              onMouseEnter={() => setActive(p.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(p.key)}
              onBlur={() => setActive(null)}
            >
              <span className={cn('size-2.5 rounded-full', p.swatch)} aria-hidden />
              <span className="w-10">{p.label}</span>
              <span className="font-semibold tabular-nums">{counts[p.key]}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{pct(counts[p.key])}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
