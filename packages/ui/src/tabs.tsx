'use client';

import { createContext, useContext, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './components';

/**
 * Small accessible tabs (WAI-ARIA tabs pattern: roving tabindex, arrow/Home/End keys, automatic
 * activation). Replaces Radix Tabs to keep ~10 KB gzip off every page.
 */
interface TabsCtx {
  value: string;
  onValueChange: (v: string) => void;
  baseId: string;
}
const Ctx = createContext<TabsCtx | null>(null);
const useTabs = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('Tabs components must be inside <Tabs>');
  return c;
};
const idOf = (base: string, kind: 'tab' | 'panel', value: string) => `${base}-${kind}-${value}`;

export function Tabs({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const baseId = useId();
  return (
    <Ctx.Provider value={{ value, onValueChange, baseId }}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  );
}

export function TabsList({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    tabs[next]!.focus();
    tabs[next]!.click();
  };
  return (
    <div
      ref={ref}
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex h-10 max-w-full items-center overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const t = useTabs();
  const selected = t.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={idOf(t.baseId, 'tab', value)}
      aria-selected={selected}
      aria-controls={idOf(t.baseId, 'panel', value)}
      tabIndex={selected ? 0 : -1}
      data-state={selected ? 'active' : 'inactive'}
      onClick={() => t.onValueChange(value)}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Only the active panel is rendered (its queries only run when visible). */
export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const t = useTabs();
  if (t.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={idOf(t.baseId, 'panel', value)}
      aria-labelledby={idOf(t.baseId, 'tab', value)}
      tabIndex={0}
      className={cn('mt-4', className)}
    >
      {children}
    </div>
  );
}
