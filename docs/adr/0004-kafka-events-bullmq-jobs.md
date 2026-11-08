# ADR-0004: Kafka for events, BullMQ for jobs

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

We need fan-out of domain facts to several services with replay and per-key ordering, and also delayed or retryable work (match timeouts, judge dispatch, emails).

## Decision

Kafka API (Redpanda) for events: 5 topics × 2 partitions, Aiven free-tier compatible. BullMQ on Redis for jobs: delays, retries with backoff, priorities, rate limits and jobId dedupe.

## Consequences

Two messaging systems to run, each used for what it is good at. Both sit behind small wrappers in `@cb/events` and `@cb/queue`.

## Alternatives considered

Kafka only: no delayed delivery, head-of-line blocking on slow jobs, parallelism capped by partitions. BullMQ/Redis Streams only: weaker replay and fan-out semantics.
