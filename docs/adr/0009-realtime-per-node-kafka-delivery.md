# ADR-0009: Realtime delivery via per-node Kafka consumer groups

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Socket.IO cross-node delivery normally depends on the Redis adapter, which makes Redis critical for realtime.

## Decision

Each realtime node consumes the event topics with its own consumer group and emits only to locally connected sockets (`user:{id}` rooms). Presence stays in Redis with TTLs.

## Consequences

Delivery keeps working when Redis is down. Every node reads every event, which is fine at our scale; switch to node-targeted routing if needed.

## Alternatives considered

Socket.IO Redis adapter in the critical path.
