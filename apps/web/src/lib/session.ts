'use client';

import type { LoginBody, Me, RegisterBody, Session } from '@cb/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AUTH_COOKIES } from '@cb/contracts/constants';
import { api, isApiError, refreshSession } from './api';

export const meKey = ['me'] as const;

/** The `cb_s` hint cookie: no hint, no session, so don't even ask (no 401 noise for visitors). */
const hasSessionHint = () =>
  typeof document !== 'undefined' &&
  document.cookie.split('; ').some((c) => c.startsWith(`${AUTH_COOKIES.session}=`));

/**
 * Swap the session: drop every other user's cached data, then update `me` in place.
 * Not `queryClient.clear()`: that also removes the `me` query, and mounted components that don't
 * re-render for another reason (e.g. the verify banner) stay attached to the removed query.
 */
function switchUser(qc: QueryClient, me: Me | null) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== meKey[0] });
  qc.setQueryData(meKey, me);
}

/** The signed-in user, or null. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<Me | null> => {
      if (!hasSessionHint()) return null;
      try {
        return await api<Me>('/auth/me');
      } catch (e) {
        if (isApiError(e) && (e.status === 401 || e.status === 404)) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (count, e) => !isApiError(e) || (e.status >= 500 && count < 2),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginBody) => api<Session>('/auth/login', { method: 'POST', body }),
    onSuccess: (s) => {
      switchUser(qc, s.user);
    },
  });
}

/** Registration doesn't sign in (plan decision log), so we log in right after. */
export function useRegister() {
  const login = useLogin();
  return useMutation({
    mutationFn: async (body: RegisterBody) => {
      await api<Me>('/auth/register', { method: 'POST', body, idempotent: true });
      return login.mutateAsync({ identifier: body.username, password: body.password });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      switchUser(qc, null);
    },
  });
}

/** After verifying, rotate the session so the access token carries ev=true. */
export function useVerifyEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      await api('/auth/verify-email', { method: 'POST', body: { token } });
      await refreshSession();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: () => api<{ sent: boolean }>('/auth/resend-verification', { method: 'POST' }),
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) => api('/auth/forgot-password', { method: 'POST', body: { email } }),
  });
}

export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { token: string; password: string }) =>
      api('/auth/reset-password', { method: 'POST', body }),
    onSuccess: () => {
      switchUser(qc, null);
    },
  });
}

/**
 * Client-side guard for protected pages: once we know there is no session (refresh failed or
 * cookies were cleared), go to /login and come back afterwards.
 */
export function useRequireAuth() {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (me.data === null) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [me.data, pathname, router]);
  return me;
}

/** Only allow same-site relative redirects (no `//evil.com`, no absolute URLs). */
export function safeNext(next: string | null, fallback = '/friends'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
