'use client';

import type { MatchState, PublicProblem, SubmissionView } from '@cb/contracts';
import { LANGUAGE_KEYS, type LanguageKey } from '@cb/contracts/constants';
import { Alert, Badge, Button, Select, Skeleton, Textarea, cn } from '@cb/ui';
import { Copy, Flag, Loader2, Play, Send, Trophy } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { notify } from '@/components/battle-global';
import { TEMPLATES } from '@/components/code-editor';
import { Markdown } from '@/components/markdown';
import { isApiError, messageFor } from '@/lib/api';
import { tabLease, useForfeit, useMatchState, useProblem, useSubmission, useSubmit } from '@/lib/battle';
import { loadDraft, loadLanguage, saveDraft, saveLanguage } from '@/lib/drafts';
import { useRealtimeEvent } from '@/lib/realtime';
import { useMe, useRequireAuth } from '@/lib/session';

// The editor is the heaviest piece; it loads on the battle page only, client-side.
const CodeEditor = dynamic(() => import('@/components/code-editor').then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
});

const LANGUAGE_LABEL: Record<LanguageKey, string> = {
  cpp: 'C++',
  java: 'Java',
  python: 'Python 3',
  javascript: 'JavaScript',
};
const VERDICT: Record<string, { label: string; tone: string }> = {
  AC: { label: 'Accepted', tone: 'text-success' },
  WA: { label: 'Wrong answer', tone: 'text-destructive' },
  TLE: { label: 'Time limit exceeded', tone: 'text-warning' },
  MLE: { label: 'Memory limit exceeded', tone: 'text-warning' },
  RE: { label: 'Runtime error', tone: 'text-destructive' },
  CE: { label: 'Compilation error', tone: 'text-destructive' },
  OLE: { label: 'Output limit exceeded', tone: 'text-warning' },
  IE: { label: 'Judge error (not your fault)', tone: 'text-muted-foreground' },
};

// ---------------- server-time countdown (plan §21.4) ----------------

/** Offset between the server clock and ours, from the state snapshot. */
function useServerOffset(state: MatchState | undefined, fetchedAt: number) {
  return useMemo(() => (state ? new Date(state.serverNow).getTime() - fetchedAt : 0), [state, fetchedAt]);
}

function useMsLeft(endsAt: string | null, offset: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return endsAt ? Math.max(0, new Date(endsAt).getTime() - (now + offset)) : null;
}

function Timer({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  const s = Math.ceil(ms / 1000);
  const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return (
    <span
      className={cn(
        'rounded-md px-3 py-1 font-mono text-lg font-semibold tabular-nums',
        ms < 60_000
          ? 'bg-destructive/15 text-destructive'
          : ms < 300_000
            ? 'bg-warning/15 text-warning'
            : 'bg-muted',
      )}
      role="timer"
      aria-label={`${Math.floor(s / 60)} minutes ${s % 60} seconds left`}
    >
      {text}
    </span>
  );
}

// ---------------- one tab per match (plan §13.5) ----------------

function useTabLease(matchId: string, active: boolean) {
  const tabId = useRef(typeof crypto !== 'undefined' ? crypto.randomUUID() : 'tab-fallback-0');
  const [blocked, setBlocked] = useState(false);
  const acquire = useCallback(
    async (takeover = false) => {
      try {
        const r = await tabLease(matchId, tabId.current, takeover);
        setBlocked(!r.granted);
      } catch {
        /* lease is a UX guard: on errors, keep the page usable */
      }
    },
    [matchId],
  );
  useEffect(() => {
    if (!active) return;
    void acquire();
    const t = setInterval(() => void acquire(), 10_000);
    return () => clearInterval(t);
  }, [acquire, active]);
  return { blocked, takeOver: () => acquire(true) };
}

// ---------------- the room ----------------

export function BattleRoom({ matchId }: { matchId: string }) {
  useRequireAuth();
  const { data: me } = useMe();
  const state = useMatchState(matchId);
  const problem = useProblem(state.data?.problemSlug);
  const offset = useServerOffset(state.data, state.dataUpdatedAt);
  const msLeft = useMsLeft(state.data?.endsAt ?? null, offset);
  const open = state.data?.status === 'in_progress' || state.data?.status === 'deciding';
  const lease = useTabLease(matchId, open);
  const opponent = state.data?.players.find((p) => p.id !== me?.id);
  const [activity, setActivity] = useState<string[]>([]);

  useRealtimeEvent('match:opponent-activity', (m) => {
    if (m.data.matchId !== matchId) return;
    const name = opponent?.username ?? 'Opponent';
    const line =
      m.data.type === 'submitted'
        ? `${name} submitted`
        : `${name}'s submission: ${VERDICT[m.data.verdict ?? '']?.label ?? m.data.verdict}`;
    setActivity((a) => [line, ...a].slice(0, 20));
    void state.refetch();
  });

  if (state.isError) {
    return (
      <Alert variant="destructive">
        {isApiError(state.error, 'NOT_FOUND')
          ? 'This match does not exist or you are not in it.'
          : messageFor(state.error)}
      </Alert>
    );
  }
  if (!state.data || !me) return <Skeleton className="h-[70vh] w-full" />;
  const s = state.data;

  return (
    <div className="fixed inset-x-0 bottom-0 top-14 z-30 flex flex-col bg-background">
      <TopBar state={s} meId={me.id} msLeft={msLeft} activity={activity[0]} />
      {s.status === 'deciding' && (
        <div
          className="border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-center text-sm"
          role="status"
        >
          Time&apos;s up or a result depends on a verdict still being judged. Deciding…
        </div>
      )}
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize="38%" minSize="20%">
          <ProblemPanel problem={problem.data} />
        </Panel>
        <Separator className="w-1.5 bg-border transition-colors hover:bg-primary/50" />
        <Panel minSize="30%">
          <Workspace
            matchId={matchId}
            state={s}
            problem={problem.data}
            disabled={!open || lease.blocked || (msLeft !== null && msLeft <= 0)}
            activity={activity}
          />
        </Panel>
      </Group>
      {lease.blocked && open && (
        <Overlay>
          <h2 className="text-xl font-semibold">This match is open in another tab</h2>
          <p className="text-muted-foreground">
            Play in one tab at a time so your code and submissions stay in sync.
          </p>
          <Button onClick={() => void lease.takeOver()}>Use here</Button>
        </Overlay>
      )}
      {(s.status === 'completed' || s.status === 'aborted') && <EndScreen state={s} meId={me.id} />}
    </div>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="grid max-w-md gap-4 rounded-xl border border-border bg-card p-6 text-center shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

function TopBar({
  state: s,
  meId,
  msLeft,
  activity,
}: {
  state: MatchState;
  meId: string;
  msLeft: number | null;
  activity: string | undefined;
}) {
  const forfeit = useForfeit(s.matchId);
  const [me, other] = [s.players.find((p) => p.id === meId), s.players.find((p) => p.id !== meId)];
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
      <span className="font-semibold">{me?.username}</span>
      <span className="text-muted-foreground">vs</span>
      <span className="font-semibold">{other?.username ?? '…'}</span>
      <span className="text-xs text-muted-foreground">
        ({s.opponentProgress.submitted} submissions, {s.opponentProgress.judged} judged)
      </span>
      {activity && (
        <Badge variant="secondary" className="hidden md:inline-flex" aria-live="polite">
          {activity}
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-2">
        <Timer ms={msLeft} />
        {(s.status === 'in_progress' || s.status === 'deciding') && (
          <Button
            variant="outline"
            size="sm"
            loading={forfeit.isPending}
            onClick={() => {
              if (window.confirm('Forfeit this match? Your opponent wins.')) forfeit.mutate();
            }}
          >
            {!forfeit.isPending && <Flag aria-hidden />} Forfeit
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------- problem ----------------

function ProblemPanel({ problem: p }: { problem: PublicProblem | undefined }) {
  if (!p) return <Skeleton className="m-4 h-64" />;
  return (
    <div className="h-full overflow-y-auto p-5">
      <h1 className="text-2xl font-bold tracking-tight">{p.title}</h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Badge
          variant={
            p.difficulty === 'Easy' ? 'success' : p.difficulty === 'Medium' ? 'warning' : 'destructive'
          }
        >
          {p.difficulty}
        </Badge>
        <Badge variant="secondary">Memory {Math.round(p.memoryLimitKb / 1024)} MB</Badge>
        {Object.entries(p.timeLimitsMs).map(([lang, ms]) => (
          <Badge key={lang} variant="secondary">
            {LANGUAGE_LABEL[lang as LanguageKey]} {(ms / 1000).toFixed(1)} s
          </Badge>
        ))}
      </div>
      <div className="mt-4 grid gap-5">
        <Markdown>{p.statementMd}</Markdown>
        <section>
          <h2 className="mb-1 font-semibold">Input</h2>
          <Markdown>{p.inputFormatMd}</Markdown>
        </section>
        <section>
          <h2 className="mb-1 font-semibold">Output</h2>
          <Markdown>{p.outputFormatMd}</Markdown>
        </section>
        {p.constraints.length > 0 && (
          <section>
            <h2 className="mb-1 font-semibold">Constraints</h2>
            <Markdown>{p.constraints.map((c) => `- ${c}`).join('\n')}</Markdown>
          </section>
        )}
        {p.examples.map((e, i) => (
          <section key={i} className="grid gap-2">
            <h2 className="font-semibold">Example {i + 1}</h2>
            <Sample label="Input" text={e.input} />
            <Sample label="Output" text={e.output} />
            {e.explanation && <Markdown className="text-sm text-muted-foreground">{e.explanation}</Markdown>}
          </section>
        ))}
      </div>
    </div>
  );
}

function Sample({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-muted-foreground">
        {label}
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-foreground"
          onClick={() => void navigator.clipboard?.writeText(text)}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          <Copy className="size-3" aria-hidden /> Copy
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-sm">{text}</pre>
    </div>
  );
}

// ---------------- editor + console ----------------

function Workspace({
  matchId,
  state,
  problem,
  disabled,
  activity,
}: {
  matchId: string;
  state: MatchState;
  problem: PublicProblem | undefined;
  disabled: boolean;
  activity: string[];
}) {
  const [lang, setLang] = useState<LanguageKey>('cpp');
  const [code, setCode] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<'result' | 'custom' | 'history' | 'opponent'>('result');
  const [customInput, setCustomInput] = useState('');
  const [lastId, setLastId] = useState<string | null>(null);
  const submit = useSubmit();
  const result = useSubmission(lastId);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // restore drafts (IndexedDB) for every language, and the last language used
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        LANGUAGE_KEYS.map(async (l) => [l, (await loadDraft(matchId, l)) ?? TEMPLATES[l]] as const),
      );
      const last = await loadLanguage(matchId);
      if (cancelled) return;
      setCode(Object.fromEntries(entries));
      if (last) setLang(last);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  const onChange = (v: string) => {
    setCode((c) => ({ ...c, [lang]: v }));
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveDraft(matchId, lang, v), 400);
  };

  const send = useCallback(
    (mode: 'submit' | 'run', withCustom = false) => {
      if (!problem || disabled || submit.isPending) return;
      submit.mutate(
        {
          mode,
          problemId: problem.id,
          matchId,
          languageKey: lang,
          code: code[lang] ?? '',
          ...(mode === 'run' && withCustom ? { customInput } : {}),
        },
        {
          onSuccess: (r) => {
            setLastId(r.submissionId);
            setTab(withCustom ? 'custom' : 'result');
          },
          onError: (e) =>
            notify(
              isApiError(e, 'RATE_LIMITED')
                ? 'Slow down: one submission every 5 seconds.'
                : isApiError(e, 'CODE_UNCHANGED')
                  ? 'You already submitted this exact code.'
                  : messageFor(e),
            ),
        },
      );
    },
    [code, customInput, disabled, lang, matchId, problem, submit],
  );

  // Ctrl+Enter submits, Ctrl+' runs (plan §21.5)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        send('submit');
      } else if (e.key === "'") {
        e.preventDefault();
        send('run');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [send]);

  return (
    <Group orientation="vertical" className="h-full">
      <Panel defaultSize="68%" minSize="25%">
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <label htmlFor="language" className="sr-only">
              Language
            </label>
            <Select
              id="language"
              value={lang}
              onChange={(e) => {
                const l = e.target.value as LanguageKey;
                setLang(l);
                void saveLanguage(matchId, l);
              }}
              className="h-8 w-40 py-0"
            >
              {LANGUAGE_KEYS.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_LABEL[l]}
                </option>
              ))}
            </Select>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Full program: read input, print output. Drafts save as you type.
            </span>
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => send('run')}
                title="Run on the samples (Ctrl+')"
              >
                <Play aria-hidden /> Run
              </Button>
              <Button
                size="sm"
                disabled={disabled}
                loading={submit.isPending}
                onClick={() => send('submit')}
                title="Submit (Ctrl+Enter)"
              >
                {!submit.isPending && <Send aria-hidden />} Submit
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {ready ? (
              <CodeEditor value={code[lang] ?? ''} onChange={onChange} language={lang} readOnly={disabled} />
            ) : (
              <Skeleton className="h-full w-full rounded-none" />
            )}
          </div>
        </div>
      </Panel>
      <Separator className="h-1.5 bg-border transition-colors hover:bg-primary/50" />
      <Panel minSize="15%">
        <div className="flex h-full flex-col">
          <div className="flex gap-1 border-b border-border px-2 pt-1" role="tablist" aria-label="Console">
            {(
              [
                ['result', 'Result'],
                ['custom', 'Custom input'],
                ['history', `My submissions (${state.mySubmissions.length})`],
                ['opponent', 'Opponent'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                className={cn(
                  'rounded-t-md px-3 py-1.5 text-sm',
                  tab === k ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm" role="tabpanel">
            {tab === 'result' && (
              <ResultView sub={result.data} pending={!!lastId && result.data?.status !== 'done'} />
            )}
            {tab === 'custom' && (
              <div className="grid gap-2">
                <Textarea
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  rows={4}
                  className="font-mono"
                  placeholder={'Your own input, e.g.\n1\n2 3'}
                  aria-label="Custom input"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="justify-self-start"
                  disabled={disabled}
                  onClick={() => send('run', true)}
                >
                  <Play aria-hidden /> Run with this input
                </Button>
                {result.data?.custom && (
                  <div className="grid gap-1">
                    <p className="text-xs text-muted-foreground">Output</p>
                    <pre className="rounded-md bg-muted p-2 font-mono">{result.data.custom.stdout ?? ''}</pre>
                    {result.data.custom.stderr && (
                      <pre className="rounded-md bg-destructive/10 p-2 font-mono text-destructive">
                        {result.data.custom.stderr}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
            {tab === 'history' && (
              <ul className="grid gap-1">
                {[...state.mySubmissions].reverse().map((m) => (
                  <li key={m.submissionId} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                      {new Date(m.submittedAt).toLocaleTimeString()}
                    </span>
                    <span className={VERDICT[m.verdict ?? '']?.tone}>
                      {m.verdict ? VERDICT[m.verdict]?.label : 'Judging…'}
                    </span>
                  </li>
                ))}
                {!state.mySubmissions.length && (
                  <li className="text-muted-foreground">No submissions yet.</li>
                )}
              </ul>
            )}
            {tab === 'opponent' && (
              <ul className="grid gap-1" aria-live="polite">
                {activity.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
                {!activity.length && (
                  <li className="text-muted-foreground">Nothing yet. You&apos;ll see when they submit.</li>
                )}
              </ul>
            )}
          </div>
        </div>
      </Panel>
    </Group>
  );
}

function ResultView({ sub, pending }: { sub: SubmissionView | undefined; pending: boolean }) {
  if (pending || (sub && sub.status !== 'done')) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Judging…
      </p>
    );
  }
  if (!sub)
    return (
      <p className="text-muted-foreground">Run your code on the samples, or submit when you&apos;re ready.</p>
    );
  const v = VERDICT[sub.verdict ?? 'IE'];
  return (
    <div className="grid gap-2" role="status">
      <p className={cn('text-lg font-semibold', v?.tone)}>
        {sub.mode === 'run' ? 'Run: ' : ''}
        {v?.label ?? sub.verdict}
      </p>
      {sub.failedFile && (
        <p>
          On the {sub.failedFile.kind} test{sub.failedCase ? `, case ${sub.failedCase}` : ''}.
        </p>
      )}
      {(sub.maxCpuMs !== null || sub.maxMemKb !== null) && (
        <p className="text-muted-foreground">
          {sub.maxCpuMs !== null && `${sub.maxCpuMs} ms`}
          {sub.maxMemKb !== null && ` · ${Math.round(sub.maxMemKb / 1024)} MB`}
        </p>
      )}
      {sub.message && (
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">{sub.message}</pre>
      )}
    </div>
  );
}

// ---------------- the end (plan §21.5) ----------------

function EndScreen({ state: s, meId }: { state: MatchState; meId: string }) {
  const won = s.winnerId === meId;
  const title =
    s.status === 'aborted' ? 'Match aborted' : s.winnerId === null ? 'Draw' : won ? 'You won!' : 'You lost';
  const reason =
    s.status === 'aborted'
      ? 'No result and no coins changed.'
      : s.endReason === 'solved'
        ? won
          ? 'You solved it first.'
          : 'Your opponent solved it first.'
        : s.endReason === 'forfeit'
          ? won
            ? 'Your opponent forfeited.'
            : 'You forfeited.'
          : "Time's up and nobody solved it.";
  return (
    <Overlay>
      {won && <Trophy className="mx-auto size-12 text-warning" aria-hidden />}
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="text-muted-foreground">{reason}</p>
      <div className="flex justify-center gap-2">
        <Button asChild>
          <Link href="/lobby">Back to the lobby</Link>
        </Button>
      </div>
    </Overlay>
  );
}
