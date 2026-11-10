import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ProblemEditor } from './problem-editor';

export const metadata: Metadata = { title: 'Edit problem' };

export default async function EditProblemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ProblemEditor id={id} />
    </Suspense>
  );
}
