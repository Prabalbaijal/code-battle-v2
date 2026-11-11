'use client';

import { Button, Field, Input } from '@cb/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLiteForm as useForm } from '@/lib/lite-form';
import { AuthCard, FormError } from '@/components/auth-card';
import { rules, setApiErrors } from '@/lib/form';
import { safeNext, useLogin } from '@/lib/session';

interface Values {
  identifier: string;
  password: string;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const login = useLogin();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ mode: 'onTouched' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      router.replace(safeNext(params.get('next')));
    } catch (err) {
      setApiErrors(err, setError, {
        fields: ['identifier', 'password'],
        messages: {
          ACCOUNT_LOCKED: 'Too many failed attempts. Try again in 15 minutes or reset your password.',
        },
      });
    }
  });

  return (
    <AuthCard
      title="Welcome back"
      description="Log in with your username or email."
      footer={
        <>
          New here?{' '}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <FormError message={errors.root?.server?.message} />
        <Field id="identifier" label="Username or email" error={errors.identifier?.message}>
          <Input {...register('identifier', rules.identifier)} autoComplete="username" autoFocus />
        </Field>
        <Field id="password" label="Password" error={errors.password?.message}>
          <Input
            {...register('password', rules.required('Password'))}
            type="password"
            autoComplete="current-password"
          />
        </Field>
        <div className="-mt-1 text-right text-sm">
          <Link
            href="/forgot-password"
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            Forgot password?
          </Link>
        </div>
        <Button type="submit" loading={isSubmitting}>
          Log in
        </Button>
      </form>
    </AuthCard>
  );
}
