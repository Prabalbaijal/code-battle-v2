#!/usr/bin/env node
// Generates dashboards/code-battle.json (plan §19). Edit here, then:
//   node infra/observability/grafana/dashboard.mjs && npx prettier --write infra/observability
// One question per panel; SLO targets drawn as thresholds; units on every panel.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ds = { type: 'prometheus', uid: 'prometheus' };
let id = 0;
let y = 0;
const panels = [];

const row = (title) => {
  panels.push({
    type: 'row',
    id: ++id,
    title,
    collapsed: false,
    gridPos: { h: 1, w: 24, x: 0, y: y++ },
    panels: [],
  });
};

function place(w, h) {
  const used = panels
    .filter((p) => p.gridPos.y === y && p.type !== 'row')
    .reduce((n, p) => n + p.gridPos.w, 0);
  if (used + w > 24) y += h;
  const x = panels.filter((p) => p.gridPos.y === y && p.type !== 'row').reduce((n, p) => n + p.gridPos.w, 0);
  return { h, w, x, y };
}
const endRow = (h) => {
  y += h;
};

const targets = (queries) =>
  queries.map(([expr, legendFormat], i) => ({
    datasource: ds,
    expr,
    legendFormat,
    refId: String.fromCharCode(65 + i),
  }));

function stat(title, expr, { unit = 'short', w = 6, thresholds, mappings, description } = {}) {
  panels.push({
    type: 'stat',
    id: ++id,
    title,
    description,
    datasource: ds,
    gridPos: place(w, 4),
    targets: targets([[expr, '']]),
    options: {
      reduceOptions: { calcs: ['lastNotNull'] },
      colorMode: 'value',
      graphMode: 'area',
      textMode: 'value',
    },
    fieldConfig: {
      defaults: {
        unit,
        ...(mappings ? { mappings } : {}),
        thresholds: thresholds ?? { mode: 'absolute', steps: [{ color: 'text', value: null }] },
      },
      overrides: [],
    },
  });
}

function series(title, queries, { unit = 'short', w = 12, slo, description, stack = false } = {}) {
  panels.push({
    type: 'timeseries',
    id: ++id,
    title,
    description,
    datasource: ds,
    gridPos: place(w, 8),
    targets: targets(queries),
    options: {
      legend: { displayMode: 'list', placement: 'bottom' },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
    fieldConfig: {
      defaults: {
        unit,
        custom: {
          lineWidth: 2,
          fillOpacity: stack ? 20 : 0,
          stacking: { mode: stack ? 'normal' : 'none' },
          showPoints: 'never',
          ...(slo !== undefined ? { thresholdsStyle: { mode: 'dashed' } } : {}),
        },
        ...(slo !== undefined
          ? {
              thresholds: {
                mode: 'absolute',
                steps: [
                  { color: 'transparent', value: null },
                  { color: 'red', value: slo },
                ],
              },
            }
          : {}),
      },
      overrides: [],
    },
  });
}

const green = (n) => ({ color: 'green', value: n });
const amber = (n) => ({ color: 'orange', value: n });
const red = (n) => ({ color: 'red', value: n });

row('Players right now');
stat('Matches in progress', 'sum(matches_active{status="in_progress"})');
stat('Matches deciding', 'sum(matches_active{status="deciding"})', {
  description: 'Waiting for a verdict after time ran out (plan §11.4).',
  thresholds: { mode: 'absolute', steps: [green(null), amber(1)] },
});
stat('Open sockets', 'sum(socket_connections)');
stat('Players online', 'max(presence_online_users)');
endRow(4);
series(
  'Match start latency p95 (SLO < 1.5 s)',
  [['histogram_quantile(0.95, sum by (le) (rate(match_start_latency_seconds_bucket[5m])))', 'p95']],
  { unit: 's', slo: 1.5 },
);
series(
  'Matches finished',
  [['sum by (end_reason) (increase(matches_finished_total[15m]))', '{{end_reason}}']],
  {
    stack: true,
  },
);
endRow(8);

row('Judge');
stat('Judge0 calls left today', 'max(judge0_budget_remaining)', {
  thresholds: { mode: 'absolute', steps: [red(null), amber(100), green(300)] },
});
stat('Judge0 breaker', 'max(judge0_breaker_open)', {
  mappings: [
    { type: 'value', options: { 0: { text: 'closed' }, 1: { text: 'half-open' }, 2: { text: 'OPEN' } } },
  ],
  thresholds: { mode: 'absolute', steps: [green(null), amber(1), red(2)] },
});
stat('Queued submissions', 'sum(judge_queue_depth{status="queued"})', {
  thresholds: { mode: 'absolute', steps: [green(null), amber(10), red(50)] },
});
stat('Running submissions', 'sum(judge_queue_depth{status="running"})');
endRow(4);
series(
  'Submit → verdict p95 (SLO < 6 s)',
  [['histogram_quantile(0.95, sum by (le, mode) (rate(judge_latency_seconds_bucket[5m])))', '{{mode}}']],
  { unit: 's', slo: 6 },
);
series(
  'Judge0 calls by result',
  [['sum by (op, result) (increase(judge0_calls_total[5m]))', '{{op}} {{result}}']],
  {
    stack: true,
  },
);
endRow(8);

row('API');
series(
  'HTTP p95 by service (SLO < 200 ms)',
  [
    [
      'histogram_quantile(0.95, sum by (le, service) (rate(http_server_duration_seconds_bucket[5m])))',
      '{{service}}',
    ],
  ],
  { unit: 's', slo: 0.2 },
);
series(
  '5xx responses by service',
  [['sum by (service) (rate(http_server_duration_seconds_count{status_code=~"5.."}[5m]))', '{{service}}']],
  { unit: 'reqps' },
);
endRow(8);

row('Events');
series('Kafka consumer lag', [['max by (group) (kafka_consumer_lag)', '{{group}}']], { w: 8 });
series('Outbox waiting to publish', [['max by (service) (outbox_unpublished)', '{{service}}']], { w: 8 });
series('Dead letters (not replayed)', [['max by (service) (dead_letters)', '{{service}}']], { w: 8 });
endRow(8);

row('Runtime');
series('Event-loop lag p99', [['max by (service) (nodejs_eventloop_lag_p99_seconds)', '{{service}}']], {
  unit: 's',
});
series('Memory (RSS)', [['max by (service) (process_resident_memory_bytes)', '{{service}}']], {
  unit: 'bytes',
});
endRow(8);

const dashboard = {
  uid: 'code-battle',
  title: 'Code Battle',
  tags: ['code-battle'],
  timezone: 'browser',
  refresh: '30s',
  time: { from: 'now-6h', to: 'now' },
  schemaVersion: 39,
  version: 1,
  panels,
};
writeFileSync(
  join(import.meta.dirname, 'dashboards', 'code-battle.json'),
  JSON.stringify(dashboard, null, 2) + '\n',
);
console.log(`${panels.length} panels`);
