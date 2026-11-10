import type { Metadata } from 'next';
import { NewProblem } from './new-problem';

export const metadata: Metadata = { title: 'New problem' };

export default function NewProblemPage() {
  return <NewProblem />;
}
