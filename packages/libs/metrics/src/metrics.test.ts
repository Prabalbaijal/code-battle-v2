import { afterAll, describe, expect, it } from 'vitest';
import { counter, gauge, histogram, initMetrics, renderMetrics, startMetricsServer } from './index.js';

describe('@cb/metrics', () => {
  initMetrics('test-service');
  const server = startMetricsServer(0);
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('get-or-create: declaring a metric twice returns the same one', () => {
    expect(counter('t_events_total', 'x', ['kind'])).toBe(counter('t_events_total', 'x', ['kind']));
  });

  it('renders counters, histograms and collected gauges with the service label', async () => {
    counter('t_calls_total', 'calls', ['result']).inc({ result: 'ok' }, 2);
    histogram('t_latency_seconds', 'latency').observe(0.03);
    gauge('t_depth', 'depth', [], (g) => g.set(7));
    gauge('t_broken', 'fails to collect', [], () => {
      throw new Error('db down');
    });
    const text = await renderMetrics();
    expect(text).toContain('t_calls_total{result="ok",service="test-service"} 2');
    expect(text).toContain('t_latency_seconds_bucket{le="0.05",service="test-service"} 1');
    expect(text).toContain('t_depth{service="test-service"} 7');
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('serves /metrics on the worker port', async () => {
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('t_depth');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
  });
});
