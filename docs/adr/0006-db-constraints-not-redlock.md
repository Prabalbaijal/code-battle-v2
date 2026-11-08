# ADR-0006: Invariants via DB constraints and CAS, not distributed locks

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Race conditions (double accept, A→B and B→A challenges, double coin awards) must be impossible, not just unlikely.

## Decision

Use primary keys, partial unique indexes and conditional updates (`UPDATE … WHERE status = …`), e.g. a `user_active_match(user_id PK)` table. Postgres advisory locks are used only for leader election of background loops.

## Consequences

Correct under crashes, GC pauses and clock drift. Redis stays a performance layer only.

## Alternatives considered

Redlock: unsafe without fencing tokens under GC pauses and clock drift.
