'use client';

import { Alert, Skeleton } from '@cb/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { LazyMarkdown as Markdown } from '@/components/lazy-markdown';
import { useNote } from '@/lib/ai';
import { messageFor } from '@/lib/api';

export function NoteView({ slug }: { slug: string }) {
  const note = useNote(slug);

  // the markdown renders after the data arrives: jump to the cited section then
  useEffect(() => {
    if (!note.data || !location.hash) return;
    const t = setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView(), 300);
    return () => clearTimeout(t);
  }, [note.data]);

  return (
    <article className="grid gap-4">
      <Link
        href="/learn"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> All notes
      </Link>
      {note.isError ? (
        <Alert variant="destructive">{messageFor(note.error)}</Alert>
      ) : !note.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <h1 className="text-2xl font-bold tracking-tight">{note.data.title}</h1>
          <Markdown anchors>{note.data.markdown}</Markdown>
        </>
      )}
    </article>
  );
}
