# Architecture Decision Records

One file per decision. Status values: Accepted, Superseded by ADR-NNNN.

| ADR                                                    | Decision                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [ADR-0001](./0001-microservices-turborepo.md)          | Microservices in a Turborepo + pnpm monorepo                            |
| [ADR-0002](./0002-postgres-per-service-drizzle.md)     | PostgreSQL, one database per service, Drizzle ORM                       |
| [ADR-0003](./0003-rest-commands-websocket-push.md)     | REST for commands, WebSocket for push only                              |
| [ADR-0004](./0004-kafka-events-bullmq-jobs.md)         | Kafka for events, BullMQ for jobs                                       |
| [ADR-0005](./0005-transactional-outbox-inbox.md)       | Transactional outbox + inbox; no producer idempotence                   |
| [ADR-0006](./0006-db-constraints-not-redlock.md)       | Invariants via DB constraints and CAS, not distributed locks            |
| [ADR-0007](./0007-earliest-submitted-ac-wins.md)       | Earliest submitted accepted solution wins (with a deciding state)       |
| [ADR-0008](./0008-hosted-judge0.md)                    | Hosted Judge0 API behind a CodeExecutor interface                       |
| [ADR-0009](./0009-realtime-per-node-kafka-delivery.md) | Realtime delivery via per-node Kafka consumer groups                    |
| [ADR-0010](./0010-jwt-refresh-socket-ticket.md)        | Short-lived EdDSA JWT + rotating refresh tokens + socket tickets        |
| [ADR-0011](./0011-nextjs-frontend.md)                  | Next.js App Router, CodeMirror 6, TanStack Query + Zustand              |
| [ADR-0012](./0012-zero-cost-hosting.md)                | ₹0 hosting: Oracle A1 VM + Vercel + self-hosted Postgres/Redis/Redpanda |
| [ADR-0013](./0013-paginated-lobby-presence.md)         | Lobby: live friends, paginated pull list for other online players       |
