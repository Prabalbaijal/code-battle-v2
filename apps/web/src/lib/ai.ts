'use client';

import type {
  AiReview,
  AiStatus,
  AiUsage,
  ErrorBody,
  Hint,
  HintRequest,
  IntegrityFlag,
  Note,
  NoteSummary,
  Recommendations,
  TutorFrame,
  TutorRequest,
} from '@cb/contracts';
import { CSRF_HEADER } from '@cb/contracts/constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, isApiError, refreshSession } from './api';
import { ratingKeys } from './rating';

export const aiKeys = {
  status: ['ai', 'status'] as const,
  review: (matchId: string) => ['ai', 'review', matchId] as const,
  hints: (problemId: string) => ['ai', 'hints', problemId] as const,
  notes: ['ai', 'notes'] as const,
  note: (slug: string) => ['ai', 'note', slug] as const,
  recommendations: ['ai', 'recommendations'] as const,
  flags: (status: string) => ['ai', 'flags', status] as const,
  usage: ['ai', 'usage'] as const,
};

/** Which AI features this server offers (the UI hides what's off). */
export function useAiStatus() {
  return useQuery({
    queryKey: aiKeys.status,
    queryFn: () => api<AiStatus>('/ai/status'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ---------------- post-match coach ----------------

/** The review for this match, polled every 3 s while the worker writes it. */
export function useReview(matchId: string, enabled: boolean) {
  return useQuery({
    queryKey: aiKeys.review(matchId),
    queryFn: async () => {
      try {
        return await api<AiReview>(`/ai/reviews/${matchId}`);
      } catch (e) {
        if (isApiError(e, 'NOT_FOUND')) return null; // not asked for yet
        throw e;
      }
    },
    enabled,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 3000 : false),
  });
}

export function useRequestReview(matchId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AiReview>('/ai/reviews', { method: 'POST', body: { matchId } }),
    onSuccess: (r) => qc.setQueryData(aiKeys.review(matchId), r),
  });
}

// ---------------- hints ----------------

export function useHints(problemId: string | undefined) {
  return useQuery({
    queryKey: aiKeys.hints(problemId ?? ''),
    queryFn: async () => (await api<{ items: Hint[] }>(`/ai/hints?problemId=${problemId}`)).items,
    enabled: !!problemId,
  });
}

export function useGetHint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: HintRequest) => api<Hint>('/ai/hints', { method: 'POST', body: req }),
    onSuccess: (h) => {
      qc.setQueryData<Hint[]>(aiKeys.hints(h.problemId), (old) =>
        [...(old ?? []).filter((x) => x.level !== h.level), h].sort((a, b) => a.level - b.level),
      );
      // coins moved: the ledger and the profile follow
      if (h.charged) void qc.invalidateQueries({ queryKey: ratingKeys.ledger });
    },
  });
}

// ---------------- learn + recommendations ----------------

export function useNotes() {
  return useQuery({
    queryKey: aiKeys.notes,
    queryFn: async () => (await api<{ items: NoteSummary[] }>('/ai/notes')).items,
    staleTime: 10 * 60_000,
  });
}

export function useNote(slug: string) {
  return useQuery({
    queryKey: aiKeys.note(slug),
    queryFn: () => api<Note>(`/ai/notes/${encodeURIComponent(slug)}`),
    staleTime: 10 * 60_000,
  });
}

export function useRecommendations(enabled: boolean) {
  return useQuery({
    queryKey: aiKeys.recommendations,
    queryFn: () => api<Recommendations>('/ai/recommendations'),
    enabled,
    retry: false,
  });
}

// ---------------- tutor (server-sent events over fetch) ----------------

/**
 * POST the question and read the answer as it streams (`data: {...}` frames). EventSource can't
 * POST or send our CSRF header, so this reads the response body directly. A 401 refreshes the
 * session once, like every other call.
 */
export async function askTutor(
  req: TutorRequest,
  onFrame: (f: TutorFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const send = () =>
    fetch('/api/v1/ai/tutor', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', [CSRF_HEADER]: '1' },
      body: JSON.stringify(req),
      ...(signal ? { signal } : {}),
    });
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && (await refreshSession())) res = await send();
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error. Check your connection.');
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null;
    throw new ApiError(
      res.status,
      body?.error.code ?? 'INTERNAL_ERROR',
      body?.error.message ?? 'The tutor failed.',
    );
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (frame.startsWith('data: ')) onFrame(JSON.parse(frame.slice(6)) as TutorFrame);
    }
  }
}

// ---------------- admin ----------------

export function useAiFlags(status: 'open' | 'cleared' | 'confirmed') {
  return useQuery({
    queryKey: aiKeys.flags(status),
    queryFn: async () => (await api<{ items: IntegrityFlag[] }>(`/admin/ai/flags?status=${status}`)).items,
    retry: false,
  });
}

export function useReviewFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: 'cleared' | 'confirmed'; note?: string }) =>
      api<IntegrityFlag>(`/admin/ai/flags/${v.id}/review`, {
        method: 'POST',
        body: { status: v.status, ...(v.note ? { note: v.note } : {}) },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai', 'flags'] }),
  });
}

export function useAiUsage() {
  return useQuery({
    queryKey: aiKeys.usage,
    queryFn: () => api<AiUsage>('/admin/ai/usage'),
    refetchInterval: 15_000,
    retry: false,
  });
}
