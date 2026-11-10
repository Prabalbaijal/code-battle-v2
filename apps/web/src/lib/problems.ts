'use client';

import type {
  AdminProblem,
  CalibrationReport,
  CreateProblemBody,
  Me,
  PutTestFileBody,
  ReferenceSolutionBody,
  UpdateProblemBody,
} from '@cb/contracts';
import type { Difficulty } from '@cb/contracts/constants';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { Page } from './friends';

export interface ProblemSummary {
  id: string;
  slug: string;
  title: string;
  difficulty: Difficulty;
  status: AdminProblem['status'];
  version: number;
  updatedAt: string;
}

/** Problem setters and admins may author problems (the gateway and service check this too). */
export const canAuthor = (me: Me | null | undefined) => me?.role === 'problem_setter' || me?.role === 'admin';

export const problemKeys = {
  list: ['admin-problems'] as const,
  one: (id: string) => ['admin-problem', id] as const,
};

const base = (id: string) => `/admin/problems/${id}`;

export function useAdminProblems() {
  return useInfiniteQuery({
    queryKey: problemKeys.list,
    queryFn: ({ pageParam }) =>
      api<Page<ProblemSummary>>(
        `/admin/problems?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

const calibrating = (c: CalibrationReport | null | undefined) =>
  c?.status === 'pending' || c?.status === 'running';

/** One problem, polled every 2 s while a calibration is running. */
export function useAdminProblem(id: string) {
  return useQuery({
    queryKey: problemKeys.one(id),
    queryFn: () => api<AdminProblem>(base(id)),
    refetchInterval: (q) => (calibrating(q.state.data?.calibration) ? 2000 : false),
    retry: false,
  });
}

/** Every admin endpoint answers with the full problem, so the cache is updated in place. */
function useProblemMutation<V>(id: string, fn: (v: V) => Promise<AdminProblem>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (p) => {
      qc.setQueryData(problemKeys.one(id), p);
      void qc.invalidateQueries({ queryKey: problemKeys.list });
    },
  });
}

export function useCreateProblem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProblemBody) => api<AdminProblem>('/admin/problems', { method: 'POST', body }),
    onSuccess: (p) => {
      qc.setQueryData(problemKeys.one(p.id), p);
      void qc.invalidateQueries({ queryKey: problemKeys.list });
    },
  });
}

export const useUpdateProblem = (id: string) =>
  useProblemMutation(id, (body: UpdateProblemBody) => api<AdminProblem>(base(id), { method: 'PATCH', body }));

export const usePutTestFile = (id: string) =>
  useProblemMutation(id, ({ ordinal, ...body }: PutTestFileBody & { ordinal: number }) =>
    api<AdminProblem>(`${base(id)}/test-files/${ordinal}`, { method: 'PUT', body }),
  );

export const useDeleteTestFile = (id: string) =>
  useProblemMutation(id, (ordinal: number) =>
    api<AdminProblem>(`${base(id)}/test-files/${ordinal}`, { method: 'DELETE' }),
  );

export const useAddReference = (id: string) =>
  useProblemMutation(id, (body: ReferenceSolutionBody) =>
    api<AdminProblem>(`${base(id)}/reference-solutions`, { method: 'POST', body }),
  );

export const useDeleteReference = (id: string) =>
  useProblemMutation(id, (refId: string) =>
    api<AdminProblem>(`${base(id)}/reference-solutions/${refId}`, { method: 'DELETE' }),
  );

export const usePublish = (id: string) =>
  useProblemMutation(id, () => api<AdminProblem>(`${base(id)}/publish`, { method: 'POST' }));

export const useArchive = (id: string) =>
  useProblemMutation(id, () => api<AdminProblem>(`${base(id)}/archive`, { method: 'POST' }));

/** Starts calibration (uses judge quota); the problem query then polls until it finishes. */
export function useCalibrate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<CalibrationReport>(`${base(id)}/calibrate`, { method: 'POST' }),
    onSuccess: (report) => {
      qc.setQueryData<AdminProblem>(problemKeys.one(id), (p) => (p ? { ...p, calibration: report } : p));
    },
  });
}
