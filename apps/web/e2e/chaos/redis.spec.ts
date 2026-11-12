import { expect, test } from '@playwright/test';
import { player, startMatch, typeCode } from '../support';
import { apiGet, chaosEnabled, note, since, start, stop } from './infra';

/**
 * Chaos drill 1 (plan §18.6): Redis stops mid-match. The match goes on (judging falls back to the
 * Postgres-driven loop, sockets still get events from Kafka), the winner gets coins, the
 * leaderboard is served from Postgres; when Redis comes back the leaderboard index and presence
 * rebuild themselves.
 */
test('drill 1: Redis stops mid-match', async ({ browser }) => {
  chaosEnabled();
  test.setTimeout(300_000);
  const a = await player(browser, 'red');
  const b = await player(browser, 'redb');
  await startMatch(a, b);

  const t0 = Date.now();
  stop('redis');
  note('redis stopped', 'mid-match');
  try {
    const t1 = Date.now();
    await typeCode(a.page, 'python', '# @fake program=sum-cases wrongCase=1\nprint(1)\n');
    await a.page.getByRole('button', { name: 'Submit' }).click();
    await expect(a.page.getByText('Wrong answer').first()).toBeVisible({ timeout: 90_000 });
    note('a submission judged without Redis (Postgres loop)', since(t1));
    await expect(b.page.getByText(/submission: Wrong answer/).first()).toBeVisible({ timeout: 30_000 });
    note('opponent activity still pushed', 'yes (Kafka → socket)');

    const t2 = Date.now();
    await typeCode(b.page, 'python', '# @fake program=sum-cases\nprint("y")\n');
    await b.page.getByRole('button', { name: 'Submit' }).click();
    await expect(b.page.getByRole('heading', { name: 'You won!' })).toBeVisible({ timeout: 90_000 });
    await expect(a.page.getByRole('heading', { name: 'You lost' })).toBeVisible({ timeout: 30_000 });
    note('accepted → winner decided without Redis', since(t2));
    await expect(b.page.getByTestId('coin-change')).toContainText('+50', { timeout: 30_000 });
    note('coins applied', '+50 / −50');

    const lb = await apiGet<{ fallback: boolean }>(b.page, '/leaderboard');
    expect(lb.fallback).toBe(true);
    note('leaderboard', 'served from Postgres (fallback)');
  } finally {
    await start('redis');
  }
  note('redis back after', since(t0));

  const t3 = Date.now();
  // the index caught up with what happened while Redis was down: the winner (450) now ranks above
  // the loser (350), served from Redis again
  await expect
    .poll(
      async () => {
        const lb = await apiGet<{ fallback: boolean }>(b.page, '/leaderboard');
        const [rb, ra] = await Promise.all([
          apiGet<{ rank: number | null }>(b.page, '/leaderboard/me'),
          apiGet<{ rank: number | null }>(a.page, '/leaderboard/me'),
        ]);
        return !lb.fallback && rb.rank !== null && ra.rank !== null && rb.rank < ra.rank;
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(true);
  note('leaderboard back on Redis with the outage results', since(t3));
  await b.page.goto('/lobby');
  await expect(b.page.getByText(/\d+ online/)).toBeVisible({ timeout: 90_000 });
  note('presence back', since(t3));
});
