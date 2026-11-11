'use client';

import type { LedgerEntry } from '@cb/contracts';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { LEDGER_LABELS, signed } from '@/lib/rating';

const W = 640;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 44 };

/** 3–5 round gridline values covering [lo, hi]. */
function ticks(lo: number, hi: number): number[] {
  const span = Math.max(hi - lo, 50);
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step / 2; v += step) out.push(v);
  return out;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Coins after every change (the v1 "performance graph"). One series, so no legend: the heading
 * names it. Points are in order of play, not spaced by time (matches come in bursts). Hover or
 * arrow keys show each point; the table below is the same data for screen readers.
 */
export function CoinChart({ entries }: { entries: LedgerEntry[] }) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);

  const geo = useMemo(() => {
    const values = entries.map((e) => e.balanceAfter);
    const g = ticks(Math.min(0, ...values), Math.max(...values));
    const lo = g[0]!;
    const hi = g.at(-1)!;
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (entries.length === 1 ? iw / 2 : (i / (entries.length - 1)) * iw);
    const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo || 1)) * ih;
    const points = entries.map((e, i) => ({ x: x(i), y: y(e.balanceAfter), e }));
    return { grid: g, y, points, step: entries.length > 1 ? iw / (entries.length - 1) : iw };
  }, [entries]);

  const onKey = (e: KeyboardEvent) => {
    if (!entries.length) return;
    const last = entries.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? Math.min(last, (active ?? -1) + 1)
        : e.key === 'ArrowLeft'
          ? Math.max(0, (active ?? last + 1) - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : e.key === 'Escape'
                ? null
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  if (entries.length < 2) {
    return <p className="text-sm text-muted-foreground">Play a match to start your coin history.</p>;
  }

  const p = active === null ? null : geo.points[active]!;
  const line = geo.points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join('');
  const tipLeft = p ? Math.min(Math.max((p.x / W) * 100, 12), 88) : 0;

  return (
    <div className="grid gap-2">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-primary"
          role="img"
          aria-labelledby={`${id}-desc`}
          tabIndex={0}
          onKeyDown={onKey}
          onMouseLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
        >
          <desc id={`${id}-desc`}>
            Coins over your last {entries.length} changes, from {entries[0]!.balanceAfter} to{' '}
            {entries.at(-1)!.balanceAfter}. Use the arrow keys to read each point.
          </desc>
          {/* recessive grid and axis labels */}
          {geo.grid.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={geo.y(v)}
                y2={geo.y(v)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={geo.y(v) + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[9px] tabular-nums"
              >
                {v}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={H - 6} className="fill-muted-foreground text-[9px]">
            {fmtDate(entries[0]!.createdAt)}
          </text>
          <text x={W - PAD.right} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[9px]">
            {fmtDate(entries.at(-1)!.createdAt)}
          </text>

          <path d={line} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" />
          {/* the latest value, always marked */}
          <circle
            cx={geo.points.at(-1)!.x}
            cy={geo.points.at(-1)!.y}
            r={4}
            className="fill-primary stroke-card"
            strokeWidth={2}
          />

          {p && (
            <g pointerEvents="none">
              <line
                x1={p.x}
                x2={p.x}
                y1={PAD.top}
                y2={H - PAD.bottom}
                className="stroke-muted-foreground"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle cx={p.x} cy={p.y} r={5} className="fill-primary stroke-card" strokeWidth={2} />
            </g>
          )}

          {/* hit targets: one full-height band per point, wider than the mark */}
          {geo.points.map((pt, i) => (
            <rect
              key={pt.e.id}
              x={pt.x - geo.step / 2}
              y={0}
              width={Math.max(geo.step, 8)}
              height={H}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
            />
          ))}
        </svg>
        {p && (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg"
            style={{ left: `${tipLeft}%` }}
            role="status"
          >
            <div className="font-semibold tabular-nums">{p.e.balanceAfter} coins</div>
            <div className="text-muted-foreground">
              {LEDGER_LABELS[p.e.reason] ?? p.e.reason} · {signed(p.e.applied)}
            </div>
            <div className="text-muted-foreground">{fmtDate(p.e.createdAt)}</div>
          </div>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show as a table</summary>
        <table className="mt-2 w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Date</th>
              <th className="py-1 font-medium">What</th>
              <th className="py-1 text-right font-medium">Change</th>
              <th className="py-1 text-right font-medium">Coins</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {[...entries].reverse().map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="py-1">{fmtDate(e.createdAt)}</td>
                <td className="py-1">{LEDGER_LABELS[e.reason] ?? e.reason}</td>
                <td className="py-1 text-right">{signed(e.applied)}</td>
                <td className="py-1 text-right">{e.balanceAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
