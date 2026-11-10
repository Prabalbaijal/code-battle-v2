'use client';

import { Alert, Button, Field, Input } from '@cb/ui';
import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { AuthCard, FormError } from '@/components/auth-card';
import { rules, setApiErrors } from '@/lib/form';
import { useForgotPassword } from '@/lib/session';

export default function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string }>({ mode: 'onTouched' });

  const onSubmit = handleSubmit(async ({ email }) => {
    try {
      await forgot.mutateAsync(email);
    } catch (err) {
      setApiErrors(err, setError, { fields: ['email'] });
    }
  });

  return (
    <AuthCard
      title="Reset your password"
      description="Enter your email and we'll send you a reset link."
      footer={
        <Link href="/login" className="hover:text-foreground hover:underline">
          Back to log in
        </Link>
      }
    >
      {forgot.isSuccess ? (
        // Same message whether or not the account exists (no account enumeration).
        <Alert variant="success">
          <MailCheck aria-hidden />
          <div>If an account uses that email, a reset link is on its way. It expires in 30 minutes.</div>
        </Alert>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <FormError message={errors.root?.server?.message} />
          <Field id="email" label="Email" error={errors.email?.message}>
            <Input {...register('email', rules.email)} type="email" autoComplete="email" autoFocus />
          </Field>
          <Button type="submit" loading={isSubmitting}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
