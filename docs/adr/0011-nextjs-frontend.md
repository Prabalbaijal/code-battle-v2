# ADR-0011: Next.js App Router, CodeMirror 6, TanStack Query + Zustand

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Public pages (landing, profiles, leaderboard) benefit from SSR/ISR and SEO; the battle room is purely client-side.

## Decision

Next.js App Router on Vercel with per-route rendering (SSG/ISR/SSR/client-only), CodeMirror 6 (much smaller than Monaco), TanStack Query for server state and Zustand for UI and socket state.

## Consequences

Faster public pages and smaller bundles; the battle room is a client island.

## Alternatives considered

Vite SPA (v1), Monaco, Redux.
