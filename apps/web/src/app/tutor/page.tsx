import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TutorView } from './tutor-view';

export const metadata: Metadata = { title: 'Tutor' };

export default function TutorPage() {
  return (
    <Suspense>
      <TutorView />
    </Suspense>
  );
}
