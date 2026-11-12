import { expect, test } from '@playwright/test';
import { player, startMatch, typeCode } from '../support';
import { chaosEnabled, note, since, start, stop } from './infra';

/**
 * Chaos drill 3 (plan §18.6): the event broker (Redpanda) stops mid-match. Actions still succeed
 * (the submission is accepted and judged; the player sees their own verdict over REST), but what
 * travels as an event (the decision, the push to the opponent) waits in the outbox and arrives
 * after the broker is back. Nothing is lost.
 */
test('drill 3: Kafka stops mid-match', async ({ browser }) => {
  chaosEnabled();
  test.setTimeout(300_000);
  const a = await player(browser, 'kaf');
  const b = await player(browser, 'kafb');
  await startMatch(a, b);

  stop('redpanda');
  note('redpanda stopped', 'mid-match');
  let back: number;
  try {
    const t1 = Date.now();
    await typeCode(b.page, 'python', '# @fake program=sum-cases\nprint("y")\n');
    await b.page.getByRole('button', { name: 'Submit' }).click();
    await expect(b.page.getByText('Accepted').first()).toBeVisible({ timeout: 90_000 });
    note('submission accepted and judged without Kafka', since(t1));
    // the decision travels as an event: it must not happen yet
    await b.page.waitForTimeout(10_000);
    await expect(b.page.getByRole('heading', { name: 'You won!' })).toHaveCount(0);
    note('result while the broker is down', 'waiting in the outbox (no winner yet)');
  } finally {
    await start('redpanda');
    back = Date.now();
  }
  await expect(b.page.getByRole('heading', { name: 'You won!' })).toBeVisible({ timeout: 120_000 });
  note('winner after the broker came back', since(back));
  await expect(a.page.getByRole('heading', { name: 'You lost' })).toBeVisible({ timeout: 60_000 });
  await expect(b.page.getByTestId('coin-change')).toContainText('+50', { timeout: 60_000 });
  note('both players see the result and coins', since(back));
});
