'use client';

import type { Citation } from '@cb/contracts';
import { Alert, Button, Skeleton, Textarea } from '@cb/ui';
import { BookOpen, FileCode2, MessagesSquare, Send, Square } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LazyMarkdown as Markdown } from '@/components/lazy-markdown';
import { askTutor, useAiStatus } from '@/lib/ai';
import { messageFor } from '@/lib/api';
import { useRequireAuth } from '@/lib/session';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  error?: string;
}

const STARTERS = [
  'When should I use prefix sums?',
  'Why does my solution get Time Limit Exceeded?',
  'How do I avoid integer overflow in C++?',
  'Explain binary search on the answer with an example.',
];

/** /tutor: the RAG tutor (plan §22.2 #3), streamed, with links to the notes it used. */
export function TutorView() {
  const me = useRequireAuth();
  const status = useAiStatus();
  const params = useSearchParams();
  const [submissionId, setSubmissionId] = useState<string | null>(params.get('submission'));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  if (me.isPending || me.data === null || status.isPending) return <Skeleton className="h-64 w-full" />;
  if (!status.data?.features.tutor) {
    return <Alert>The tutor isn’t available on this server right now.</Alert>;
  }

  const ask = async (question: string) => {
    const q = question.trim();
    if (q.length < 3 || busy) return;
    const history = turns
      .filter((t) => !t.error && t.content)
      .slice(-6)
      .map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: 'user', content: q }, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const update = (f: (t: Turn) => Turn) => setTurns((all) => [...all.slice(0, -1), f(all.at(-1)!)]);
    try {
      await askTutor(
        { question: q, history, ...(submissionId ? { submissionId } : {}) },
        (frame) => {
          if (frame.type === 'citations') update((t) => ({ ...t, citations: frame.items }));
          else if (frame.type === 'delta') update((t) => ({ ...t, content: t.content + frame.text }));
          else if (frame.type === 'error') update((t) => ({ ...t, error: frame.message }));
        },
        ctrl.signal,
      );
      setSubmissionId(null); // the submission was the first question's context
    } catch (err) {
      if ((err as Error).name !== 'AbortError') update((t) => ({ ...t, error: messageFor(err) }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <MessagesSquare className="size-6 text-primary" aria-hidden /> Tutor
        </h1>
        <p className="text-sm text-muted-foreground">
          Ask about algorithms, verdicts or your own submissions. Answers cite the{' '}
          <Link href="/learn" className="text-primary hover:underline">
            notes
          </Link>{' '}
          they use. Off during a match.
        </p>
      </div>

      {submissionId && (
        <Alert className="flex items-center gap-2 text-sm">
          <FileCode2 className="size-4 shrink-0" aria-hidden />
          Your submission is attached to the next question.
          <button type="button" className="ml-auto text-xs underline" onClick={() => setSubmissionId(null)}>
            Remove
          </button>
        </Alert>
      )}

      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {(submissionId ? ['Why did this submission fail?'] : STARTERS).map((s) => (
            <Button key={s} variant="secondary" size="sm" onClick={() => void ask(s)}>
              {s}
            </Button>
          ))}
        </div>
      )}

      <ol className="grid gap-4" aria-live="polite">
        {turns.map((t, i) => (
          <li
            key={i}
            className={
              t.role === 'user'
                ? 'justify-self-end rounded-lg bg-primary/10 px-4 py-2 text-sm'
                : 'grid gap-2 rounded-lg border border-border p-4'
            }
          >
            {t.role === 'user' ? (
              t.content
            ) : (
              <>
                {t.content ? (
                  <Markdown className="text-sm">{t.content}</Markdown>
                ) : (
                  !t.error && <Skeleton className="h-4 w-2/3" />
                )}
                {t.error && <p className="text-sm text-destructive">{t.error}</p>}
                {t.citations && t.citations.length > 0 && t.content && (
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                    {t.citations.map((c) => (
                      <li key={c.n} className="inline-flex items-center gap-1">
                        <BookOpen className="size-3" aria-hidden />[{c.n}]{' '}
                        {c.href ? (
                          <Link href={c.href} className="hover:text-foreground hover:underline">
                            {c.title}
                          </Link>
                        ) : (
                          c.title
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </li>
        ))}
      </ol>
      <div ref={end} />

      <form
        className="sticky bottom-4 grid gap-2 rounded-lg border border-border bg-background p-3 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }}
          rows={2}
          maxLength={2000}
          placeholder="Ask a question (Enter to send, Shift+Enter for a new line)"
          aria-label="Your question"
        />
        <div className="flex justify-end gap-2">
          {busy ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => abort.current?.abort()}>
              <Square aria-hidden /> Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={input.trim().length < 3}>
              <Send aria-hidden /> Ask
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
