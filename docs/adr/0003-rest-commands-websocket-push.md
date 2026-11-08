# ADR-0003: REST for commands, WebSocket for push only

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

In v1 all game logic ran in Socket.IO handlers that trusted identity from payloads. That caused most of the v1 bugs: the client declared the winner, anyone could join any room, and results were emitted before commit.

## Decision

All state-changing actions (challenge, accept, forfeit, submit) are REST calls with Idempotency-Key, auth and rate limits. Realtime nodes only authenticate, track presence and deliver server events.

## Consequences

Thin, stateless socket nodes; commands are retryable and testable. Clients resync via REST on reconnect or sequence gaps.

## Alternatives considered

Socket RPC for commands (v1): harder to make idempotent, authorize and test.
