'use client';

import { Button } from '@cb/ui';
import { MailWarning } from 'lucide-react';
import { messageFor } from '@/lib/api';
import { useMe, useResendVerification } from '@/lib/session';

/** Shown to signed-in users until they verify (playing and friend requests need it). */
export function VerifyBanner() {
  const { data: me } = useMe();
  const resend = useResendVerification();
  if (!me || me.emailVerified) return null;

  return (
    <div className="border-b border-warning/30 bg-warning/10">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6">
        <MailWarning className="size-4 shrink-0 text-warning" aria-hidden />
        <p className="min-w-0 flex-1">
          Verify <strong className="font-medium">{me.email}</strong> to send friend requests and play.
        </p>
        <p role="status" className="text-muted-foreground">
          {resend.isSuccess
            ? resend.data.sent
              ? 'Sent. Check your inbox.'
              : 'Already verified.'
            : resend.isError
              ? messageFor(resend.error)
              : null}
        </p>
        {!resend.isSuccess && (
          <Button size="sm" variant="outline" loading={resend.isPending} onClick={() => resend.mutate()}>
            Resend email
          </Button>
        )}
      </div>
    </div>
  );
}
