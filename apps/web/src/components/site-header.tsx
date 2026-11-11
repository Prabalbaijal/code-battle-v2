'use client';

import { Button, cn, Skeleton, UserAvatar } from '@cb/ui';
import { LogOut, Swords } from 'lucide-react';
import { LazyNotificationBell } from './lazy';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { isAdmin } from '@/lib/judge';
import { canAuthor } from '@/lib/problems';
import { useLogout, useMe } from '@/lib/session';

const NAV = [
  { href: '/lobby', label: 'Lobby' },
  { href: '/friends', label: 'Friends' },
];
/** Public: signed-out visitors can browse the leaderboard. */
const PUBLIC_NAV = [{ href: '/leaderboard', label: 'Leaderboard' }];
const AUTHOR_NAV = [{ href: '/admin/problems', label: 'Problems' }];
const ADMIN_NAV = [{ href: '/admin/judge', label: 'Judge' }];

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

        {!isPending && (
          <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto text-sm">
            {[
              ...(me ? NAV : []),
              ...PUBLIC_NAV,
              ...(me && canAuthor(me) ? AUTHOR_NAV : []),
              ...(me && isAdmin(me) ? ADMIN_NAV : []),
            ].map((n) => (
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
              <LazyNotificationBell />
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
