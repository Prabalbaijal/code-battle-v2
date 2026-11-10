'use client';

import { Button, Field, Input } from '@cb/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { AuthCard, FormError } from '@/components/auth-card';
import { rules, setApiErrors } from '@/lib/form';
import { useRegister } from '@/lib/session';

interface Values {
  fullname: string;
  username: string;
  email: string;
  password: string;
  confirm: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const signUp = useRegister();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ mode: 'onTouched' });

  const onSubmit = handleSubmit(async ({ confirm: _confirm, ...body }) => {
    try {
      await signUp.mutateAsync(body);
      router.replace('/friends');
    } catch (err) {
      setApiErrors(err, setError, {
        fields: ['fullname', 'username', 'email', 'password'],
        codeToField: { EMAIL_TAKEN: 'email', USERNAME_TAKEN: 'username' },
      });
    }
  });

  return (
    <AuthCard
      title="Create your account"
      description="We'll send a link to verify your email."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-4">
        <FormError message={errors.root?.server?.message} />
        <Field id="fullname" label="Full name" error={errors.fullname?.message}>
          <Input {...register('fullname', rules.fullname)} autoComplete="name" autoFocus maxLength={60} />
        </Field>
        <Field
          id="username"
          label="Username"
          error={errors.username?.message}
          hint="3–20 letters, digits or _. Can't be changed later."
        >
          <Input
            {...register('username', rules.username)}
            autoComplete="username"
            maxLength={20}
            spellCheck={false}
          />
        </Field>
        <Field id="email" label="Email" error={errors.email?.message}>
          <Input {...register('email', rules.email)} type="email" autoComplete="email" />
        </Field>
        <Field id="password" label="Password" error={errors.password?.message} hint="At least 8 characters.">
          <Input {...register('password', rules.password)} type="password" autoComplete="new-password" />
        </Field>
        <Field id="confirm" label="Confirm password" error={errors.confirm?.message}>
          <Input {...register('confirm', rules.confirm)} type="password" autoComplete="new-password" />
        </Field>
        <Button type="submit" loading={isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
