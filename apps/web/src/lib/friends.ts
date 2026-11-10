'use client';

import type { Profile, ProfileView } from '@cb/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export type Friend = Profile & { since: string };
export interface FriendRequest {
  user: Profile;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  return s.toString();
};

export const keys = {
  friends: ['friends'] as const,
  requests: (direction: 'incoming' | 'outgoing') => ['friend-requests', direction] as const,
  search: (q: string) => ['user-search', q] as const,
  profile: (username: string) => ['profile', username.toLowerCase()] as const,
};

export function useFriends() {
  return useInfiniteQuery({
    queryKey: keys.friends,
    queryFn: ({ pageParam }) => api<Page<Friend>>(`/friends?${qs({ cursor: pageParam, limit: 20 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useFriendRequests(direction: 'incoming' | 'outgoing') {
  return useInfiniteQuery({
    queryKey: keys.requests(direction),
    queryFn: ({ pageParam }) =>
      api<Page<FriendRequest>>(`/friends/requests?${qs({ direction, cursor: pageParam, limit: 20 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useUserSearch(q: string) {
  return useInfiniteQuery({
    queryKey: keys.search(q),
    queryFn: ({ pageParam }) =>
      api<Page<Profile> & { fuzzy: boolean }>(`/users/search?${qs({ q, cursor: pageParam, limit: 10 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: q.length >= 1,
    staleTime: 30_000,
  });
}

export function useProfile(username: string) {
  return useQuery({
    queryKey: keys.profile(username),
    queryFn: () => api<ProfileView>(`/users/${encodeURIComponent(username)}`),
    retry: false,
  });
}

/** Every friendship change refreshes lists and any open profile. */
function useFriendMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.friends }),
        qc.invalidateQueries({ queryKey: ['friend-requests'] }),
        qc.invalidateQueries({ queryKey: ['profile'] }),
      ]),
  });
}

export const useSendFriendRequest = () =>
  useFriendMutation((toUserId: string) =>
    api<{ status: 'pending' | 'accepted'; user: Profile }>('/friends/requests', {
      method: 'POST',
      body: { toUserId },
      idempotent: true,
    }),
  );
export const useAcceptRequest = () =>
  useFriendMutation((userId: string) => api(`/friends/requests/${userId}/accept`, { method: 'POST' }));
export const useRejectRequest = () =>
  useFriendMutation((userId: string) => api(`/friends/requests/${userId}/reject`, { method: 'POST' }));
export const useCancelRequest = () =>
  useFriendMutation((userId: string) => api(`/friends/requests/${userId}`, { method: 'DELETE' }));
export const useRemoveFriend = () =>
  useFriendMutation((userId: string) => api(`/friends/${userId}`, { method: 'DELETE' }));
