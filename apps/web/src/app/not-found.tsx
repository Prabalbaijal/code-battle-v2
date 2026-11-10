import { Button } from '@cb/ui';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="grid place-items-center gap-4 py-24 text-center">
      <p className="font-mono text-sm text-primary">404</p>
      <h1 className="text-3xl font-bold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">That page doesn&apos;t exist or has moved.</p>
      <Button asChild variant="outline">
        <Link href="/">Back home</Link>
      </Button>
    </div>
  );
}
