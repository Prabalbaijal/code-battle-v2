import type { Metadata } from 'next';
import { JudgeView } from './judge-view';

export const metadata: Metadata = { title: 'Judge' };

export default function AdminJudgePage() {
  return <JudgeView />;
}
