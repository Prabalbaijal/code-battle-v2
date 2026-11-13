import type { Metadata } from 'next';
import { NoteView } from './note-view';

export const metadata: Metadata = { title: 'Learn' };

export default async function NotePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <NoteView slug={slug} />;
}
