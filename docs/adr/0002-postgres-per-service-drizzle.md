# ADR-0002: PostgreSQL, one database per service, Drizzle ORM

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

The core invariants (one active match per user, unique friendships, idempotent coin changes) are relational and need constraints, transactions and compare-and-set updates. v1 used MongoDB with read-modify-write updates that lost writes.

## Decision

PostgreSQL 16 for all transactional data, one logical database and role per service (one cluster in dev and demo). Drizzle ORM + drizzle-kit migrations: close to SQL, with explicit partial indexes, `RETURNING` and row locks. pgvector covers embeddings.

## Consequences

Strong guarantees from constraints and CAS; no cross-service joins (data is shared via events and APIs). Schema changes follow expand/contract.

## Alternatives considered

MongoDB (v1): weaker multi-document guarantees for these invariants. Prisma: less control over SQL features.
