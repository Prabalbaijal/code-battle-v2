'use client';

import type { Challenge } from '@cb/contracts';

import { Button, UserAvatar } from '@cb/ui';
import { Loader2, Swords, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, isApiError, messageFor } from '@/lib/api';
import {
  battleKeys,
  liveStore,
  setFriendStatus,
  useActiveMatch,
  useAnswerChallenge,
  useLive,
} from '@/lib/battle';
import { realtime, useRealtimeEvent, useRealtimeStatus } from '@/lib/realtime';
import { useMe } from '@/lib/session';

// ---------------- notices (small, transient) ----------------

interface Notice {
  id: number;
  text: string;
}
let notices: Notice[] = [];
const noticeListeners = new Set<() => void>();
let nextNotice = 1;
export function notify(text: string) {
  const id = nextNotice++;
  notices = [...notices, { id, text }];
  noticeListeners.forEach((f) => f());
  setTimeout(() => {
    notices = notices.filter((n) => n.id !== id);
    noticeListeners.forEach((f) => f());
  }, 5000);
}
function Notices() {
  const list = useSyncExternalStore(
    (f) => {
      noticeListeners.add(f);
      return () => noticeListeners.delete(f);
    },
    () => notices,
    () => [],
  );
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 grid gap-2"
      role="status"
      aria-live="polite"
    >
      {list.map((n) => (
        <div key={n.id} className="rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-lg">
          {n.text}
        </div>
      ))}
    </div>
  );
}

// ---------------- socket → app state ----------------

/** Starts the socket for signed-in users and turns server events into UI state (plan §21.4). */
function RealtimeBridge() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (me) realtime.start();
    else realtime.stop();
  }, [me]);

  // A challenge sent while this tab wasn't connected (page load, network blip) is still pending:
  // fetch it on every (re)connect so the modal never misses one.
  const status = useRealtimeStatus();
  useEffect(() => {
    if (status !== 'connected') return;
    void api<{ items: Challenge[] }>('/challenges?direction=incoming')
      .then(({ items }) =>
        liveStore.set((s) => ({
          incoming: [
            ...s.incoming.filter((c) => !items.some((i) => i.id === c.challengeId)),
            ...items.map((c) => ({
              challengeId: c.id,
              from: {
                userId: c.from.id,
                username: c.from.username,
                fullname: c.from.fullname,
                avatarUrl: c.from.avatarUrl,
              },
              expiresAt: c.expiresAt,
            })),
          ],
        })),
      )
      .catch(() => undefined);
  }, [status]);

  useRealtimeEvent('presence:snapshot', (m) => liveStore.set({ friends: m.data.friends }));
  useRealtimeEvent('presence:update', (m) => setFriendStatus(m.data.userId, m.data.status));
  useRealtimeEvent('challenge:received', (m) =>
    liveStore.set((s) => ({
      incoming: [...s.incoming.filter((c) => c.challengeId !== m.data.challengeId), m.data],
    })),
  );
  useRealtimeEvent('challenge:updated', (m) => {
    const { challengeId, status, matchId } = m.data;
    const wasMine = (qc.getQueryData<{ id: string }[]>(battleKeys.outgoing) ?? []).some(
      (c) => c.id === challengeId,
    );
    liveStore.set((s) => ({ incoming: s.incoming.filter((c) => c.challengeId !== challengeId) }));
    void qc.invalidateQueries({ queryKey: battleKeys.outgoing });
    if (status === 'accepted' && matchId) liveStore.set({ preparing: { matchId } });
    else if (wasMine)
      notify(status === 'rejected' ? 'Your challenge was declined.' : `Your challenge ${status}.`);
  });
  useRealtimeEvent('match:started', (m) => {
    liveStore.set({ preparing: null });
    void qc.invalidateQueries({ queryKey: battleKeys.active });
    if (pathname !== `/battle/${m.data.matchId}`) router.push(`/battle/${m.data.matchId}`);
  });
  useRealtimeEvent('match:aborted', (m) => {
    liveStore.set({ preparing: null });
    notify(m.data.reason);
    void qc.invalidateQueries({ queryKey: battleKeys.active });
    void qc.invalidateQueries({ queryKey: battleKeys.match(m.data.matchId) });
  });
  useRealtimeEvent('match:ended', (m) => {
    void qc.invalidateQueries({ queryKey: battleKeys.active });
    void qc.invalidateQueries({ queryKey: battleKeys.match(m.data.matchId) });
  });
  useRealtimeEvent(
    'match:deciding',
    (m) => void qc.invalidateQueries({ queryKey: battleKeys.match(m.data.matchId) }),
  );
  useRealtimeEvent('submission:verdict', (m) => {
    void qc.invalidateQueries({ queryKey: battleKeys.submission(m.data.submissionId) });
    if (m.data.matchId) void qc.invalidateQueries({ queryKey: battleKeys.match(m.data.matchId) });
  });
  return null;
}

// ---------------- incoming challenge (plan §21.5: countdown ring) ----------------

function CountdownRing({ expiresAt, total = 30 }: { expiresAt: string; total?: number }) {
  const [left, setLeft] = useState(() => Math.max(0, (new Date(expiresAt).getTime() - Date.now()) / 1000));
  useEffect(() => {
    const t = setInterval(
      () => setLeft(Math.max(0, (new Date(expiresAt).getTime() - Date.now()) / 1000)),
      250,
    );
    return () => clearInterval(t);
  }, [expiresAt]);
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 52 52" className="size-14" role="img" aria-label={`${Math.ceil(left)} seconds left`}>
      <circle cx="26" cy="26" r={r} fill="none" strokeWidth="4" className="stroke-muted" />
      <circle
        cx="26"
        cy="26"
        r={r}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset] duration-200"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - left / total)}
        transform="rotate(-90 26 26)"
      />
      <text x="26" y="31" textAnchor="middle" className="fill-foreground text-sm font-semibold">
        {Math.ceil(left)}
      </text>
    </svg>
  );
}

function IncomingChallenge() {
  const incoming = useLive((s) => s.incoming);
  const answer = useAnswerChallenge();
  const router = useRouter();
  const current = incoming.find((c) => new Date(c.expiresAt).getTime() > Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!current) return;
    const ms = new Date(current.expiresAt).getTime() - Date.now();
    const t = setTimeout(
      () => liveStore.set((s) => ({ incoming: s.incoming.filter((c) => c !== current) })),
      ms,
    );
    return () => clearTimeout(t);
  }, [current]);
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') decide('reject');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!current) return null;

  function decide(action: 'accept' | 'reject') {
    if (!current) return;
    setError(null);
    answer.mutate(
      { id: current.challengeId, action },
      {
        onSuccess: (r) => {
          liveStore.set((s) => ({
            incoming: s.incoming.filter((c) => c.challengeId !== current.challengeId),
          }));
          if (action === 'accept' && r.matchId) {
            if (r.status === 'in_progress') router.push(`/battle/${r.matchId}`);
            else if (r.status !== 'aborted') liveStore.set({ preparing: { matchId: r.matchId } });
          }
        },
        onError: (e) => {
          setError(
            isApiError(e, 'USER_IN_ACTIVE_MATCH') ? 'One of you is already in a match.' : messageFor(e),
          );
          liveStore.set((s) => ({
            incoming: s.incoming.filter((c) => c.challengeId !== current.challengeId),
          }));
        },
      },
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="challenge-title"
        className="grid w-full max-w-sm gap-4 rounded-xl border border-border bg-card p-6 shadow-xl"
      >
        <div className="flex items-center gap-3">
          <UserAvatar name={current.from.fullname} size="md" />
          <div className="min-w-0 flex-1">
            <p id="challenge-title" className="font-semibold">
              {current.from.username} challenges you
            </p>
            <p className="text-sm text-muted-foreground">A 30-minute 1v1 coding battle.</p>
          </div>
          <CountdownRing expiresAt={current.expiresAt} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <Button className="flex-1" loading={answer.isPending} onClick={() => decide('accept')} autoFocus>
            {!answer.isPending && <Swords aria-hidden />} Accept
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            disabled={answer.isPending}
            onClick={() => decide('reject')}
          >
            <X aria-hidden /> Decline
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------- "Preparing match…" and the rejoin banner ----------------

function Preparing() {
  const preparing = useLive((s) => s.preparing);
  useEffect(() => {
    if (!preparing) return;
    // if match:started never arrives (socket down), the rejoin banner takes over
    const t = setTimeout(() => liveStore.set({ preparing: null }), 15_000);
    return () => clearTimeout(t);
  }, [preparing]);
  if (!preparing) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm"
      role="status"
    >
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-6 py-4 shadow-xl">
        <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
        <span className="font-medium">Preparing match…</span>
      </div>
    </div>
  );
}

function RejoinBanner() {
  const { data: me } = useMe();
  const pathname = usePathname();
  const active = useActiveMatch(!!me);
  const m = active.data;
  if (!m || pathname.startsWith('/battle/')) return null;
  return (
    <div className="border-b border-primary/40 bg-primary/10">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2 text-sm sm:px-6">
        <Swords className="size-4 text-primary" aria-hidden />
        <span className="flex-1">
          You have a match in progress{m.opponent ? ` against ${m.opponent.username}` : ''}.
        </span>
        <Button asChild size="sm">
          <Link href={`/battle/${m.matchId}`}>Rejoin match</Link>
        </Button>
      </div>
    </div>
  );
}

export function BattleGlobal() {
  return (
    <>
      <RealtimeBridge />
      <RejoinBanner />
      <IncomingChallenge />
      <Preparing />
      <Notices />
    </>
  );
}
