# ADR-0007: Earliest submitted accepted solution wins (with a deciding state)

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Judge latency varies per submission, so "first judged" would reward luck, not speed.

## Decision

The winner is the participant whose accepted submission has the earliest server-side `submitted_at`. If an earlier submission is still pending, the match enters `deciding` until it resolves (capped; on timeout with missing verdicts the match aborts with no coin change).

## Consequences

Fair outcomes; a slightly more complex state machine, unit-tested in `domain/match-rules`.

## Alternatives considered

First judged AC (unfair); a client-declared winner (v1, insecure).
