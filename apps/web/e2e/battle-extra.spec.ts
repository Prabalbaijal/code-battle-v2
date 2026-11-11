import { expect, test } from '@playwright/test';
import { player, startMatch } from './support';

/** More Phase 3 behaviour in real browsers: one tab per match, and the timeout. */

test('one tab per match: a second tab is told, and "Use here" moves the match there', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await player(browser, 'tab');
  const b = await player(browser, 'tabmate');
  await startMatch(a, b);

  const second = await a.page.context().newPage();
  await second.goto(a.page.url());
  const notice = (p: typeof second) => p.getByText('This match is open in another tab');
  await expect(notice(second)).toBeVisible({ timeout: 20_000 });
  await second.getByRole('button', { name: 'Use here' }).click();
  await expect(notice(second)).toBeHidden({ timeout: 10_000 });
  // BroadcastChannel tells the first tab at once, well before its next 10 s renewal
  await expect(notice(a.page)).toBeVisible({ timeout: 3_000 });
});

// Needs battle-service running with MATCH_DURATION_SECONDS=60.
test('timeout: nobody solves it in time → a draw for both', async ({ browser }) => {
  test.skip(process.env.E2E_SHORT_MATCH !== '1', 'set E2E_SHORT_MATCH=1 with a 60 s match stack');
  test.setTimeout(240_000);
  const a = await player(browser, 'slow');
  const b = await player(browser, 'slower');
  await startMatch(a, b);
  for (const p of [a, b]) {
    await expect(p.page.getByRole('heading', { name: 'Draw' })).toBeVisible({ timeout: 120_000 });
    await expect(p.page.getByText("Time's up and nobody solved it.")).toBeVisible();
  }
});
