import { createServer, type Server } from 'node:http';
import client from 'prom-client';

/**
 * Prometheus metrics (plan §19). One registry per process, labelled with the service name;
 * Prometheus scrapes `GET /metrics` (API processes, through @cb/http-server) or the worker's own
 * metrics port (`startMetricsServer`). Never routed by the gateway or Caddy.
 */
export const registry = new client.Registry();
let started = false;

/** Node runtime metrics (CPU, memory, event-loop lag, GC) + a default `service` label. */
export function initMetrics(service: string): void {
  if (started) return;
  started = true;
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
}

const existing = <T>(name: string) => registry.getSingleMetric(name) as T | undefined;

/** Get-or-create, so modules can declare their metrics without caring who registered first. */
export function counter<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
): client.Counter<L> {
  return (
    existing<client.Counter<L>>(name) ??
    new client.Counter({ name, help, labelNames: [...labelNames], registers: [registry] })
  );
}

export function gauge<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
  /** Called on every scrape (e.g. a cheap count from Postgres). Errors leave the last value. */
  collect?: (g: client.Gauge<L>) => Promise<void> | void,
): client.Gauge<L> {
  const found = existing<client.Gauge<L>>(name);
  if (found) return found;
  return new client.Gauge({
    name,
    help,
    labelNames: [...labelNames],
    registers: [registry],
    ...(collect
      ? {
          async collect(this: client.Gauge<L>) {
            try {
              await collect(this);
            } catch {
              // keep the previous value; a failing scrape must not break /metrics
            }
          },
        }
      : {}),
  });
}

export function histogram<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
  buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
): client.Histogram<L> {
  return (
    existing<client.Histogram<L>>(name) ??
    new client.Histogram({ name, help, labelNames: [...labelNames], buckets, registers: [registry] })
  );
}

export const metricsContentType = registry.contentType;
export const renderMetrics = () => registry.metrics();

/** Workers have no HTTP server: expose `/metrics` on its own port (inside the private network). */
export function startMetricsServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    renderMetrics().then(
      (body) => res.writeHead(200, { 'content-type': metricsContentType }).end(body),
      (err: unknown) => res.writeHead(500).end(String(err)),
    );
  });
  server.listen(port, '0.0.0.0');
  return server;
}

export type { Counter, Gauge, Histogram } from 'prom-client';
