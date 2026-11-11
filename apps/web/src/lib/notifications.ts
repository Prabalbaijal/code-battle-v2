'use client';

import type { Notification } from '@cb/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: ['notifications', 'list'] as const,
  unread: ['notifications', 'unread'] as const,
};

export function useUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: async () => (await api<{ count: number }>('/notifications/unread-count')).count,
    enabled,
    // the socket pushes new ones; this only catches what a disconnected tab missed
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useNotifications(enabled = true) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list,
    queryFn: ({ pageParam }) =>
      api<{ items: Notification[]; nextCursor: string | null }>(
        `/notifications?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Notification>(`/notifications/${id}/read`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useMarkAllRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ updated: number }>('/notifications/read-all', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

/** One line of text and where clicking it goes. */
export function describe(n: Notification): { text: string; href: string | null } {
  switch (n.type) {
    case 'friend_request':
      return { text: `@${n.payload.from.username} sent you a friend request`, href: '/friends' };
    case 'friend_accepted':
      return {
        text: `@${n.payload.by.username} accepted your friend request`,
        href: `/u/${n.payload.by.username}`,
      };
    case 'challenge_received': {
      const who = `@${n.payload.from.username}`;
      const text =
        n.payload.status === 'expired'
          ? `You missed a challenge from ${who}`
          : n.payload.status === 'pending'
            ? `${who} challenged you`
            : `${who} challenged you (${n.payload.status})`;
      return { text, href: n.payload.status === 'expired' ? '/lobby' : null };
    }
    case 'match_result': {
      const p = n.payload;
      const vs = p.opponent ? ` vs @${p.opponent.username}` : '';
      const outcome =
        p.result === 'win'
          ? 'You won'
          : p.result === 'loss'
            ? 'You lost'
            : p.result === 'draw'
              ? 'Draw'
              : 'Match over';
      const coins = p.coinDelta === null ? '' : ` · ${p.coinDelta > 0 ? '+' : ''}${p.coinDelta} coins`;
      return { text: `${outcome}${vs}${coins}`, href: null };
    }
  }
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short' });
}
