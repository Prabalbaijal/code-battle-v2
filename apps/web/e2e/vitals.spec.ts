import { expect, test, type Page } from '@playwright/test';
import { player } from './support';

/**
 * Core Web Vitals on a throttled "mid-range phone on 4G" (plan §21.4 targets: LCP < 2.5 s,
 * CLS < 0.1, INP < 200 ms). Measured with the browser's own PerformanceObservers, the same
 * numbers Lighthouse reports, in the browser the E2E suite already drives.
 */
const TARGET = { lcp: 2500, cls: 0.1, inp: 200 };

async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150, // ms RTT ("slow 4G")
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
}

/** Installed before any page script runs, so nothing is missed. */
const OBSERVE = () => {
  const w = window as unknown as { __v: { lcp: number; cls: number; inp: number } };
  w.__v = { lcp: 0, cls: 0, inp: 0 };
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.__v.lcp = e.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
      if (!e.hadRecentInput) w.__v.cls += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.__v.inp = Math.max(w.__v.inp, e.duration);
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
};

async function measure(page: Page, path: string, interact?: (p: Page) => Promise<void>) {
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForTimeout(2500); // late content (queries, lazy chunks) can still shift or paint
  if (interact) {
    // a person taps once the page has settled (socket, lazy chunks, link prefetches)
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await interact(page);
    await page.waitForTimeout(500);
  }
  const v = await page.evaluate(
    () => (window as unknown as { __v: { lcp: number; cls: number; inp: number } }).__v,
  );
  test.info().annotations.push({
    type: 'vitals',
    description: `${path}: LCP ${Math.round(v.lcp)} ms, CLS ${v.cls.toFixed(3)}, INP ${Math.round(v.inp)} ms`,
  });
  // eslint-disable-next-line no-console -- the numbers are the point of this spec
  console.log(
    `${path.padEnd(28)} LCP ${String(Math.round(v.lcp)).padStart(5)} ms  CLS ${v.cls.toFixed(3)}  INP ${Math.round(v.inp)} ms`,
  );
  expect.soft(v.lcp, `${path} LCP`).toBeLessThan(TARGET.lcp);
  expect.soft(v.cls, `${path} CLS`).toBeLessThan(TARGET.cls);
  expect.soft(v.inp, `${path} INP`).toBeLessThan(TARGET.inp);
}

test('web vitals on a throttled phone profile', async ({ browser }) => {
  test.setTimeout(240_000);
  const me = await player(browser, 'vita');

  const anon = await (
    await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true })
  ).newPage();
  await anon.addInitScript(OBSERVE);
  await throttle(anon);
  await measure(anon, '/');
  await measure(anon, '/login', (p) => p.getByLabel('Username or email').click());
  await measure(anon, '/leaderboard');

  await me.page.addInitScript(OBSERVE);
  await throttle(me.page);
  await measure(me.page, '/lobby');
  await measure(me.page, '/leaderboard', (p) => p.getByRole('tab', { name: 'Friends' }).click());
  await measure(me.page, `/u/${me.username}`);
  await measure(me.page, '/notifications');
});
