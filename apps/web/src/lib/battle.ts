'use client';

import type {
  ActiveMatch,
  Challenge,
  CreateSubmissionBody,
  MatchState,
  OnlinePlayer,
  PresenceFriend,
  PresenceStatus,
  PublicProblem,
  SubmissionView,
  TabLeaseResult,
} from '@cb/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from './api';

export const battleKeys = {
  active: ['active-match'] as const,
  match: (id: string) => ['match', id] as const,
  outgoing: ['challenges', 'outgoing'] as const,
  friends: ['presence-friends'] as const,
  online: (q: string) => ['presence-online', q] as const,
  count: ['presence-count'] as const,
  problem: (slug: string) => ['problem', slug] as const,
  submission: (id: string) => ['submission', id] as const,
};

// ---------------- a tiny store for live UI state (no extra state library) ----------------

export interface IncomingChallenge {
  challengeId: string;
  from: { userId: string; username: string; fullname: string; avatarUrl: string | null };
  expiresAt: string;
}
interface LiveState {
  incoming: IncomingChallenge[];
  /** Accepted, waiting for `match:started` ("Preparing match…"). */
  preparing: { matchId: string } | null;
  /** Latest friend statuses from `presence:snapshot` / `presence:update`. */
  friends: PresenceFriend[];
}
let live: LiveState = { incoming: [], preparing: null, friends: [] };
const liveListeners = new Set<() => void>();
export const liveStore = {
  get: () => live,
  set(patch: Partial<LiveState> | ((s: LiveState) => Partial<LiveState>)) {
    live = { ...live, ...(typeof patch === 'function' ? patch(live) : patch) };
    for (const fn of liveListeners) fn();
  },
  subscribe(fn: () => void) {
    liveListeners.add(fn);
    return () => liveListeners.delete(fn);
  },
};
export function useLive<T>(select: (s: LiveState) => T): T {
  return useSyncExternalStore(
    liveStore.subscribe,
    () => select(live),
    () => select({ incoming: [], preparing: null, friends: [] }),
  );
}
export function setFriendStatus(userId: string, status: PresenceStatus) {
  liveStore.set((s) => ({ friends: s.friends.map((f) => (f.userId === userId ? { ...f, status } : f)) }));
}

// ---------------- matches and challenges ----------------

export function useActiveMatch(enabled = true) {
  return useQuery({
    queryKey: battleKeys.active,
    queryFn: async () => (await api<{ match: ActiveMatch | null }>('/matches/active')).match,
    enabled,
    staleTime: 15_000,
  });
}

export function useMatchState(id: string) {
  return useQuery({
    queryKey: battleKeys.match(id),
    queryFn: () => api<MatchState>(`/matches/${id}/state`),
    retry: false,
  });
}

export function useOutgoingChallenges(enabled = true) {
  return useQuery({
    queryKey: battleKeys.outgoing,
    queryFn: async () => (await api<{ items: Challenge[] }>('/challenges?direction=outgoing')).items,
    enabled,
  });
}

export function useChallenge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (toUserId: string) =>
      api<Challenge>('/challenges', { method: 'POST', body: { toUserId }, idempotent: true }),
    onSettled: () => qc.invalidateQueries({ queryKey: battleKeys.outgoing }),
  });
}

export function useAnswerChallenge() {
  const qc = useQueryClient();
  return useMutation({
    /** Accept returns the match it started; reject/cancel return the challenge. */
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: 'accept' | 'reject' | 'cancel';
    }): Promise<{ matchId: string | null; status: string }> => {
      if (action === 'accept') {
        return api<{ matchId: string; status: string }>(`/challenges/${id}/accept`, {
          method: 'POST',
          idempotent: true,
        });
      }
      const c = await api<Challenge>(`/challenges/${id}/${action}`, { method: 'POST' });
      return { matchId: c.matchId, status: c.status };
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: battleKeys.outgoing }),
        qc.invalidateQueries({ queryKey: battleKeys.active }),
      ]),
  });
}

export function useForfeit(matchId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/matches/${matchId}/forfeit`, { method: 'POST' }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: battleKeys.match(matchId) }),
        qc.invalidateQueries({ queryKey: battleKeys.active }),
      ]),
  });
}

export const tabLease = (matchId: string, tabId: string, takeover = false) =>
  api<TabLeaseResult>(`/matches/${matchId}/tab-lease`, { method: 'POST', body: { tabId, takeover } });

// ---------------- presence (lobby) ----------------

export function useOnlinePlayers(prefix: string) {
  return useInfiniteQuery({
    queryKey: battleKeys.online(prefix),
    queryFn: async ({ pageParam }) => {
      if (prefix) {
        const r = await api<{ items: OnlinePlayer[] }>(
          `/presence/online/search?prefix=${encodeURIComponent(prefix)}`,
        );
        return { items: r.items, nextCursor: null as string | null };
      }
      return api<{ items: OnlinePlayer[]; nextCursor: string | null }>(
        `/presence/online?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // pulled, never pushed (plan §13.3): refresh every 15 s while the tab is visible
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useOnlineCount() {
  return useQuery({
    queryKey: battleKeys.count,
    queryFn: async () => (await api<{ count: number }>('/presence/online/count')).count,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

// ---------------- problem and submissions ----------------

export function useProblem(slug: string | null | undefined) {
  return useQuery({
    queryKey: battleKeys.problem(slug ?? ''),
    queryFn: () => api<PublicProblem>(`/problems/${slug}`),
    enabled: !!slug,
    staleTime: Infinity,
  });
}

export function useSubmit() {
  return useMutation({
    mutationFn: (body: CreateSubmissionBody) =>
      api<{ submissionId: string; status: string }>('/submissions', {
        method: 'POST',
        body,
        idempotent: true,
      }),
  });
}

/** A submission's result: the socket says when it's done; polling is the fallback. */
export function useSubmission(id: string | null) {
  return useQuery({
    queryKey: battleKeys.submission(id ?? ''),
    queryFn: () => api<SubmissionView>(`/submissions/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === 'done' ? false : 3000),
  });
}
