#!/usr/bin/env node
/* eslint-disable no-console -- a CLI report */
// First Load JS per route (plan §21.4): fetch each page's HTML from a running `next start`, collect
// its <script src> chunks, and sum their gzip size from .next/static. That's what a browser
// downloads before the page is interactive (lazy chunks such as the editor are not counted).
//
//   node scripts/check-budgets.mjs [baseUrl]      (default http://localhost:3000)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BASE = process.argv[2] ?? process.env.WEB_URL ?? 'http://localhost:3000';
const STATIC = join(import.meta.dirname, '..', '.next');
const KB = 1024;

/**
 * Plan §21.4, adjusted 2026-11-12: React 19 + Next 16 alone are ~127 KB, so player pages get 175 KB
 * (the plan said 170). Admin editor pages (problem setters, desktop) 200 KB; the battle room 260 KB
 * (the editor itself loads lazily on top).
 */
const DEFAULT_BUDGET = 175 * KB;
const ADMIN_EDITOR = 200 * KB;
const ROUTES = [
  { path: '/' },
  { path: '/login' },
  { path: '/register' },
  { path: '/forgot-password' },
  { path: '/leaderboard' },
  { path: '/lobby', session: true },
  { path: '/friends', session: true },
  { path: '/notifications', session: true },
  { path: '/u/someone' },
  { path: '/admin/problems', session: true },
  { path: '/admin/problems/new', session: true, budget: ADMIN_EDITOR },
  { path: '/admin/problems/00000000-0000-7000-8000-000000000000', session: true, budget: ADMIN_EDITOR },
  { path: '/admin/judge', session: true },
  { path: '/verify-email' },
  { path: '/reset-password' },
  { path: '/battle/00000000-0000-7000-8000-000000000000', session: true, budget: 260 * KB },
];

const sizes = new Map();
const gz = (src) => {
  if (!sizes.has(src)) {
    const file = join(STATIC, decodeURIComponent(src.replace(/^\/_next\//, '').split('?')[0]));
    sizes.set(src, gzipSync(readFileSync(file), { level: 9 }).length);
  }
  return sizes.get(src);
};

let failed = 0;
const rows = [];
for (const r of ROUTES) {
  // the session hint cookie only gets past the optimistic redirect; the page shell is the same
  const res = await fetch(BASE + r.path, {
    headers: r.session ? { cookie: 'cb_s=1' } : {},
    redirect: 'manual',
  });
  if (res.status !== 200) {
    console.error(`${r.path}: HTTP ${res.status}`);
    failed++;
    continue;
  }
  const html = await res.text();
  // `noModule` scripts (Next's legacy polyfills) are never downloaded by modern browsers
  const tags = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]).filter((t) => !/nomodule/i.test(t));
  const scripts = [
    ...new Set(tags.map((t) => /src="(\/_next\/[^"]+\.js[^"]*)"/.exec(t)?.[1]).filter(Boolean)),
  ];
  const total = scripts.reduce((n, s) => n + gz(s), 0);
  const budget = r.budget ?? DEFAULT_BUDGET;
  const ok = total <= budget;
  if (!ok) failed++;
  rows.push({
    route: r.path.replace(/0{8}-.*$/, '[id]'),
    'first load (gz)': `${(total / KB).toFixed(1)} KB`,
    budget: `${budget / KB} KB`,
    chunks: scripts.length,
    ok: ok ? '✓' : '✗ over',
  });
}
console.table(rows);
if (failed) {
  console.error(`${failed} route(s) over budget or failing`);
  process.exit(1);
}
