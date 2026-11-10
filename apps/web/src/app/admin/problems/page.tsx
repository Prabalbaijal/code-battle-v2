import type { Metadata } from 'next';
import { ProblemsList } from './problems-list';

export const metadata: Metadata = { title: 'Problems' };

export default function AdminProblemsPage() {
  return <ProblemsList />;
}
