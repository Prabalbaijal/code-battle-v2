import { cookies, headers } from 'next/headers';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';

/**
 * Server Components → gateway, with the visitor's own cookie (plan §21.3), so a page can arrive
 * with its data already in the HTML instead of waiting for the browser to ask. Never throws: a
 * failure returns null and the client fetches as usual. Server-only (imports next/headers).
 */
export async function serverGet<T>(path: string, timeoutMs = 3000): Promise<T | null> {
  try {
    const [jar, h] = await Promise.all([cookies(), headers()]);
    const fwd = h.get('x-forwarded-for');
    const r = await fetch(`${GATEWAY_URL}/api/v1${path}`, {
      headers: {
        ...(jar.size ? { cookie: jar.toString() } : {}),
        ...(fwd ? { 'x-forwarded-for': fwd } : {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
