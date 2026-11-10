'use client';

import { Alert, Button, Field, Input } from '@cb/ui';
import { CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { AuthCard, FormError } from '@/components/auth-card';
import { rules, setApiErrors, SERVER } from '@/lib/form';
import { useResetPassword } from '@/lib/session';

interface Values {
  password: string;
  confirm: string;
}

export function ResetPasswordForm() {
  const token = useSearchParams().get('token');
  const reset = useResetPassword();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ mode: 'onTouched' });

  const onSubmit = handleSubmit(async ({ password }) => {
    if (!token) return setError(SERVER, { message: 'This reset link is missing its token.' });
    try {
      await reset.mutateAsync({ token, password });
    } catch (err) {
      setApiErrors(err, setError, {
        fields: ['password'],
        messages: { TOKEN_INVALID: 'This link is invalid, expired or already used. Request a new one.' },
      });
    }
  });

  return (
    <AuthCard
      title="Choose a new password"
      description="Resetting signs you out on every device."
      footer={
        <Link href="/forgot-password" className="hover:text-foreground hover:underline">
          Request a new link
        </Link>
      }
    >
      {reset.isSuccess ? (
        <div className="grid gap-4">
          <Alert variant="success">
            <CheckCircle2 aria-hidden />
            <div>Password updated. Log in with your new password.</div>
          </Alert>
          <Button asChild>
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <FormError message={errors.root?.server?.message} />
          <Field
            id="password"
            label="New password"
            error={errors.password?.message}
            hint="At least 8 characters."
          >
            <Input
              {...register('password', rules.password)}
              type="password"
              autoComplete="new-password"
              autoFocus
            />
          </Field>
          <Field id="confirm" label="Confirm password" error={errors.confirm?.message}>
            <Input {...register('confirm', rules.confirm)} type="password" autoComplete="new-password" />
          </Field>
          <Button type="submit" loading={isSubmitting}>
            Update password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
