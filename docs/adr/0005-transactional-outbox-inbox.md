# ADR-0005: Transactional outbox + inbox; no producer idempotence

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Writing to the DB and then publishing to Kafka (dual write) loses or invents events on crashes. Consumers see at-least-once delivery.

## Decision

Services write events to an `outbox` table (and jobs to `job_outbox`) inside the business transaction. A relay publishes after commit using `FOR UPDATE SKIP LOCKED`. Consumers insert into `processed_events` in the same transaction as their effect. Poison messages go to `dead_letters`. kafkajs idempotent mode is off: it needs infinite retries, which would block the relay while holding row locks.

## Consequences

Exactly-once effect on top of at-least-once delivery; events are never lost while Kafka is down. Trace context is carried in the envelope (`traceparent`).

## Alternatives considered

Direct publish after commit (loses events); CDC with Debezium (too heavy for a single free VM).
