'use client';

import type { AdminJudgeView, Me } from '@cb/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export const isAdmin = (me: Me | null | undefined) => me?.role === 'admin';

const key = ['admin-judge'] as const;

/** Quota, degradation level and drift; refreshed every 10 s while the page is open. */
export function useJudgeAdmin() {
  return useQuery({
    queryKey: key,
    queryFn: () => api<AdminJudgeView>('/admin/judge'),
    refetchInterval: 10_000,
    retry: false,
  });
}

/** Queue a drift check now (one Judge0 request); the worker records it within a minute. */
export function useDriftCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ queued: true }>('/admin/judge/drift-check', { method: 'POST' }),
    onSuccess: () => {
      // the check takes a few seconds in the worker
      setTimeout(() => void qc.invalidateQueries({ queryKey: key }), 8000);
    },
  });
}
