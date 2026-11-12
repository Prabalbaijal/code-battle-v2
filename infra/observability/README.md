# Observability (plan §19)

Every process exposes Prometheus metrics; Prometheus scrapes them every 15 s; Grafana shows one
dashboard and evaluates the alerts. All free and self-hosted.

```sh
docker compose -f infra/docker-compose.yml --profile obs up -d   # Prometheus :9090, Grafana :3001
```

Grafana: <http://localhost:3001> (anonymous read-only on localhost; admin password from
`GRAFANA_ADMIN_PASSWORD`, default `admin` in dev). Dashboard **Code Battle**.

## Where the metrics come from

| Process       | Endpoint                         |
| ------------- | -------------------------------- |
| API processes | `GET /metrics` on their own port |
| Workers       | `METRICS_PORT` (dev 9401–9407)   |
| Redpanda      | `:9644/public_metrics`           |

Neither is reachable from the internet: the gateway only routes `/api/*`, and Caddy only exposes
the web app and `/socket.io`.

| Metric                                                                                                | From                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------- |
| `http_server_duration_seconds{service,method,route,status_code}`                                      | every API (route pattern) |
| `match_start_latency_seconds`, `matches_finished_total`, `matches_active`                             | battle                    |
| `judge_latency_seconds`, `judge_verdicts_total`, `judge0_calls_total`, `judge0_call_duration_seconds` | judge worker              |
| `judge_queue_depth`, `judge0_budget_remaining`, `judge0_breaker_open` (any process)                   | judge API                 |
| `socket_connections`, `presence_online_users`                                                         | realtime                  |
| `kafka_consumer_lag{group,topic,partition}`, `events_consumed_total`                                  | every consumer            |
| `outbox_unpublished`, `dead_letters`, `events_published_total`                                        | every outbox relay        |
| `emails_total`, `leaderboard_reads_total{source}`                                                     | notification, rating      |
| Node runtime (CPU, RSS, heap, event-loop lag, GC)                                                     | every process             |

## Dashboard

Generated from `grafana/dashboard.mjs` (edit there, then
`node infra/observability/grafana/dashboard.mjs && npx prettier --write infra/observability`).
Rows: players right now, judge, API, events, runtime. SLO targets (match start p95 < 1.5 s,
submit → verdict p95 < 6 s, API p95 < 200 ms) are drawn as dashed thresholds.

## Alerts

`grafana/provisioning/alerting/code-battle.yml`: Judge0 breaker open (2 min), Judge0 budget below
100, consumer lag > 100 for 5 min, outbox not draining for 5 min, new dead letters, 5xx above 5 % for
5 min. They go to `ALERT_EMAIL` **once SMTP is configured**: set `GF_SMTP_ENABLED=true`,
`GF_SMTP_HOST` (e.g. Brevo's `smtp-relay.brevo.com:587`), `GF_SMTP_USER`, `GF_SMTP_PASSWORD` and
`GF_SMTP_FROM_ADDRESS` in the environment. Without SMTP, firing alerts are still visible in
Grafana under Alerting.

## Production

The production compose file runs the same two containers with targets by service name instead of
`host.docker.internal`, Grafana behind a password (no anonymous access), and Prometheus retention of
7 days (about 1 GB at this scale).
