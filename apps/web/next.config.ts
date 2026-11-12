import type { NextConfig } from 'next';

/**
 * Where the browser may open sockets besides this origin. In production Caddy serves the realtime
 * node on the site's own origin (`'self'` covers it); in dev the socket goes straight to the
 * realtime node, e.g. `REALTIME_ORIGIN=http://localhost:4010`.
 */
const realtime = process.env.REALTIME_ORIGIN?.replace(/\/$/, '');
const realtimeSrc = realtime ? [realtime, realtime.replace(/^http/, 'ws')] : [];

/**
 * Plan §16 CSP. Next.js bootstraps with inline scripts, so `script-src` allows inline but nothing
 * from other origins and no eval; a nonce would force every page to render dynamically. The rest
 * is strict: no plugins, no framing, no foreign forms or base URLs, connections only to us.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", // Tailwind/KaTeX inline styles
  "img-src 'self' data: blob: https://res.cloudinary.com",
  "font-src 'self' data:",
  `connect-src ${["'self'", ...realtimeSrc].join(' ')}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // `next dev` needs eval for fast refresh: the policy applies to production builds only.
  ...(process.env.NODE_ENV === 'production' ? [{ key: 'Content-Security-Policy', value: csp }] : []),
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@cb/ui'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'res.cloudinary.com' }],
  },
};

export default config;
