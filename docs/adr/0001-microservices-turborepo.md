# ADR-0001: Microservices in a Turborepo + pnpm monorepo

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Code Battle has parts with very different load profiles: judge orchestration (spiky, quota-bound), realtime (connection-heavy), CRUD services (light) and AI (slow, costly). v1 was one Express process where a slow judge call or a socket bug affected everything.

## Decision

Split into services by business capability (identity, user, battle, problem, judge, rating, notification, realtime, ai, gateway) in one Turborepo with pnpm workspaces. Shared code lives in `packages/{contracts,domain,libs,config}`; each service owns its schema and migrations.

## Consequences

Independent scaling and failure isolation; more moving parts (Kafka, outbox, more processes). Shared libs keep each service small. `scripts/check-deps.mjs` enforces dependency direction in CI.

## Alternatives considered

A modular monolith with the same boundaries: a valid and simpler choice for a small team. Microservices were chosen deliberately to demonstrate the patterns; the module boundaries would survive a merge back.
