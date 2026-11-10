'use client';

import { Alert, Button, Spinner } from '@cb/ui';
import { CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { AuthCard } from '@/components/auth-card';
import { isApiError, messageFor } from '@/lib/api';
import { useMe, useVerifyEmail } from '@/lib/session';

export function VerifyEmail() {
  const token = useSearchParams().get('token');
  const verify = useVerifyEmail();
  const { data: me } = useMe();
  const sent = useRef(false);

  // The token is single-use: make sure StrictMode's double effect only sends it once.
  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    verify.mutate(token);
  }, [token, verify]);

  const next = me ? '/friends' : '/login';

  if (!token) {
    return (
      <AuthCard title="Verify your email">
        <p className="text-sm text-muted-foreground">Open the link from your verification email.</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Verify your email">
      {verify.isSuccess ? (
        <div className="grid gap-4">
          <Alert variant="success">
            <CheckCircle2 aria-hidden />
            <div>Your email is verified. You're ready to battle.</div>
          </Alert>
          <Button asChild>
            <Link href={next}>{me ? 'Go to friends' : 'Log in'}</Link>
          </Button>
        </div>
      ) : verify.isError ? (
        <div className="grid gap-4">
          <Alert variant="destructive">
            <XCircle aria-hidden />
            <div>
              {isApiError(verify.error, 'TOKEN_INVALID')
                ? 'This link is invalid or has expired. Request a new one from the banner after logging in.'
                : messageFor(verify.error)}
            </div>
          </Alert>
          <Button asChild variant="outline">
            <Link href={next}>Continue</Link>
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner className="size-4" /> Verifying…
        </p>
      )}
    </AuthCard>
  );
}
