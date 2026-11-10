'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCreateProblem } from '@/lib/problems';
import { toCreateBody } from '@/lib/problem-form';
import { StatementForm } from '../statement-form';

export function NewProblem() {
  const router = useRouter();
  const create = useCreateProblem();
  return (
    <div className="grid gap-6">
      <div>
        <Link
          href="/admin/problems"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden /> Problems
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">New problem</h1>
        <p className="mt-1 text-muted-foreground">
          Start with the statement. Test files and reference solutions come next.
        </p>
      </div>
      <StatementForm
        submitLabel="Create draft"
        onSubmit={async (values) => {
          const p = await create.mutateAsync(toCreateBody(values));
          router.push(`/admin/problems/${p.id}?tab=tests`);
        }}
      />
    </div>
  );
}
