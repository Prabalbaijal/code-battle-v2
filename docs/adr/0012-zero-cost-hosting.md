# ADR-0012: ₹0 hosting: Oracle A1 VM + Vercel + self-hosted Postgres/Redis/Redpanda

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Free PaaS tiers sleep or are gone (Render sleeps after 15 min, Fly.io is trial-only, Koyeb closed); Upstash free Redis would run out on BullMQ polling; Neon free compute would be kept awake by our pollers.

## Decision

Run all services, Postgres, Redis and Redpanda with docker compose on one Oracle Always Free Ampere A1 VM (2 OCPU / 12 GB). Next.js on Vercel Hobby. Hosted Judge0 for code execution.

## Consequences

Always-on workers for free; a single VM is a single point of failure for the demo, mitigated by backups and graceful degradation.

## Alternatives considered

Render/Fly/Koyeb, Neon, Upstash (see context).
