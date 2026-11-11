'use client';

import type {
  HistoryPage,
  Leaderboard,
  LedgerEntry,
  MyRank,
  PresenceQueryResult,
  PresenceStatus,
  ProfilePageView,
} from '@cb/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './api';

export const ratingKeys = {
  leaderboard: (scope: 'global' | 'friends') => ['leaderboard', scope] as const,
  myRank: ['leaderboard', 'me'] as const,
  // under 'profile' so friendship changes (which invalidate ['profile']) refresh it too
  profilePage: (username: string) => ['profile', username.toLowerCase(), 'page'] as const,
  history: ['history'] as const,
  ledger: ['ledger'] as const,
  matchCoins: (matchId: string) => ['ledger', 'match', matchId] as const,
};

export function useLeaderboard(scope: 'global' | 'friends', enabled = true) {
  return useQuery({
    queryKey: ratingKeys.leaderboard(scope),
    queryFn: () => api<Leaderboard>(`/leaderboard?scope=${scope}`),
    enabled,
    staleTime: 15_000,
  });
}

export function useMyRank(enabled = true) {
  return useQuery({ queryKey: ratingKeys.myRank, queryFn: () => api<MyRank>('/leaderboard/me'), enabled });
}

/** One call: profile + coins/level + (own profile) the last 10 matches with real coin changes. */
export function useProfilePage(username: string, initial?: ProfilePageView | null) {
  return useQuery({
    queryKey: ratingKeys.profilePage(username),
    queryFn: () => api<ProfilePageView>(`/bff/profile/${encodeURIComponent(username)}`),
    retry: false,
    // rendered on the server for a fast first paint, then refreshed once in the background (the
    // server may have seen an expired access cookie and rendered the signed-out view)
    ...(initial ? { initialData: initial, initialDataUpdatedAt: 0 } : {}),
  });
}

/** Older matches after the first 10 the profile already has. */
export function useHistory(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ratingKeys.history,
    queryFn: ({ pageParam }) =>
      api<HistoryPage>(`/bff/history?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

/** The player's coin balance over time (own profile only; the ledger is private). */
export function useCoinHistory(enabled: boolean) {
  return useQuery({
    queryKey: ratingKeys.ledger,
    queryFn: async () => {
      const items: LedgerEntry[] = [];
      let cursor: string | null = null;
      // newest first, up to 300 points: plenty for a profile chart
      for (let i = 0; i < 3; i++) {
        const page: { items: LedgerEntry[]; nextCursor: string | null } = await api(
          `/stats/me/ledger?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        items.push(...page.items);
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return items.reverse();
    },
    enabled,
  });
}

/**
 * What a finished match did to my coins. rating-service applies it a moment after the match ends,
 * so this polls briefly until the ledger row is there (the socket's `stats:updated` also refreshes it).
 */
export function useMatchCoins(matchId: string, enabled: boolean) {
  return useQuery({
    queryKey: ratingKeys.matchCoins(matchId),
    queryFn: async () => {
      const r = await api<{ items: LedgerEntry[] }>(`/stats/me/ledger?matchIds=${matchId}`);
      const row = r.items[0];
      return row ? { applied: row.applied, delta: row.delta, balance: row.balanceAfter } : null;
    },
    enabled,
    refetchInterval: (q) => (q.state.data || q.state.dataUpdateCount > 15 ? false : 1000),
  });
}

/** Online dots for a list of players (signed-in viewers only; the presence API needs a user). */
export function usePresence(userIds: string[], enabled: boolean) {
  const ids = [...new Set(userIds)].slice(0, 100);
  return useQuery({
    queryKey: ['presence', 'query', ids.join(',')],
    queryFn: async () =>
      (await api<PresenceQueryResult>('/presence/query', { method: 'POST', body: { userIds: ids } }))
        .statuses,
    enabled: enabled && ids.length > 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    select: (s): Record<string, PresenceStatus> => s,
  });
}

export const LEDGER_LABELS: Record<string, string> = {
  signup_bonus: 'Welcome bonus',
  match_win: 'Won a match',
  match_loss: 'Lost a match',
  match_timeout: 'Timed out',
  forfeit_win: 'Opponent forfeited',
  forfeit_loss: 'Forfeited',
  migration: 'Carried over from v1',
};

export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
