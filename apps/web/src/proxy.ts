import { AUTH_COOKIES } from '@cb/contracts/constants';
import { NextResponse, type NextRequest } from 'next/server';

/** Pages that need a session. */
const PROTECTED = ['/friends', '/settings'];
/** Pages pointless for a signed-in user. */
const GUEST_ONLY = ['/login', '/register'];

const matches = (path: string, list: string[]) => list.some((p) => path === p || path.startsWith(`${p}/`));

/**
 * Optimistic guard only (plan §21.3): it checks that a session *might* exist (the `cb_s` hint
 * cookie) to avoid flashing protected pages. Real authorization happens at the gateway.
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSession = req.cookies.has(AUTH_COOKIES.session);

  if (!hasSession && matches(pathname, PROTECTED)) {
    const url = new URL('/login', req.url);
    url.searchParams.set('next', pathname + search);
    return NextResponse.redirect(url);
  }
  if (hasSession && matches(pathname, GUEST_ONLY)) {
    return NextResponse.redirect(new URL('/friends', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/friends/:path*', '/settings/:path*', '/login', '/register'],
};
