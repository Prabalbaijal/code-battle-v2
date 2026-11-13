import type { Metadata } from 'next';
import { AiAdminView } from './ai-admin-view';

export const metadata: Metadata = { title: 'AI' };

export default function AdminAiPage() {
  return <AiAdminView />;
}
