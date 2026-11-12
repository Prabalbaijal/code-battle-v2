import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test, type Page } from '@playwright/test';

/**
 * Chaos drills (plan §18.6) drive the real dev stack: infra containers through Docker Compose,
 * fake-judge0 through its fault switch. They stop shared containers, so they only run when asked:
 * `E2E_CHAOS=1 pnpm --filter @cb/web e2e e2e/chaos`.
 */
export const chaosEnabled = () => {
  test.skip(process.env.E2E_CHAOS !== '1', 'chaos drills stop shared containers: set E2E_CHAOS=1');
};

const COMPOSE_FILE = join(import.meta.dirname, '../../../../infra/docker-compose.yml');
const FAKE_JUDGE0 = process.env.FAKE_JUDGE0_URL ?? 'http://localhost:2358';

const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'pipe' }).toString();

export function stop(service: 'redis' | 'redpanda') {
  compose('stop', service);
}

/** Start it again and wait until its healthcheck passes. */
export async function start(service: 'redis' | 'redpanda', timeoutMs = 90_000) {
  compose('start', service);
  const id = compose('ps', '-q', service).trim();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = execFileSync('docker', ['inspect', '-f', '{{.State.Health.Status}}', id])
      .toString()
      .trim();
    if (health === 'healthy') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${service} did not become healthy`);
}

/** fake-judge0 answers every request with `status` for the next `count` requests. */
export const judgeFaults = (status: number, count: number) =>
  fetch(`${FAKE_JUDGE0}/__fake/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, count }),
  });
/** The judge is back: clear the fault (submissions in flight are kept). */
export const judgeHeal = () => fetch(`${FAKE_JUDGE0}/__fake/faults`, { method: 'DELETE' });

/** GET through the web's own proxy with the page's cookies. */
export async function apiGet<T>(page: Page, path: string): Promise<T> {
  const r = await page.request.get(`/api/v1${path}`);
  if (!r.ok()) throw new Error(`${path}: ${r.status()} ${await r.text()}`);
  return (await r.json()) as T;
}

/** Record a measured step for the drill report (also printed). */
export function note(label: string, value: string) {
  test.info().annotations.push({ type: 'drill', description: `${label}: ${value}` });
  // eslint-disable-next-line no-console -- drill output is the point
  console.log(`  [drill] ${label}: ${value}`);
}

export const since = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
