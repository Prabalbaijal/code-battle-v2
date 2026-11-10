'use client';

import { Button, cn, Skeleton, UserAvatar } from '@cb/ui';
import { LogOut, Swords } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { canAuthor } from '@/lib/problems';
import { useLogout, useMe } from '@/lib/session';

const NAV = [{ href: '/friends', label: 'Friends' }];
const AUTHOR_NAV = [{ href: '/admin/problems', label: 'Problems' }];

export function SiteHeader() {
  const { data: me, isPending } = useMe();
  const logout = useLogout();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Swords className="size-5 text-primary" aria-hidden />
          Code Battle
        </Link>

        {me && (
          <nav aria-label="Main" className="flex items-center gap-1 text-sm">
            {[...NAV, ...(canAuthor(me) ? AUTHOR_NAV : [])].map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={pathname.startsWith(n.href) ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground',
                  pathname.startsWith(n.href) && 'bg-muted text-foreground',
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2">
          {isPending ? (
            <Skeleton className="h-8 w-24" />
          ) : me ? (
            <>
              <Link
                href={`/u/${me.username}`}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
              >
                <UserAvatar name={me.fullname} size="sm" />
                <span className="hidden sm:inline">{me.username}</span>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Log out"
                title="Log out"
                loading={logout.isPending}
                onClick={() => logout.mutate(undefined, { onSettled: () => router.push('/') })}
              >
                {!logout.isPending && <LogOut />}
              </Button>
            </>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Log in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/register">Sign up</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
