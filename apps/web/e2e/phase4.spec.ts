import { expect, test } from '@playwright/test';
import { player, SHOTS, startMatch } from './support';

/**
 * Phase 4: coins move after a match (end screen, profile history with the real delta, chart),
 * the leaderboard ranks it, and notifications arrive live (bell badge, friend request toast).
 * Needs the whole stack, including rating-service and notification-service's worker.
 */
test('Phase 4: coins, leaderboard, profile and notifications', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await player(browser, 'cara');
  const b = await player(browser, 'dev');

  await test.step('a friend request shows up live for the other player', async () => {
    await b.page.goto('/lobby');
    await expect(b.page.getByText(/\d+ online/)).toBeVisible({ timeout: 20_000 }); // b's socket is up
    await a.page.goto(`/u/${b.username}`);
    await a.page.getByRole('button', { name: 'Add friend' }).click();
    await expect(b.page.getByText(`@${a.username} sent you a friend request`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(b.page.getByRole('button', { name: /Notifications, 1 unread/ })).toBeVisible();

    // accepting tells the sender, and answers (reads) the request on b's side
    await b.page.goto(`/u/${a.username}`);
    await b.page.getByRole('button', { name: 'Accept' }).click();
    await expect(a.page.getByText(`@${b.username} accepted your friend request`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(b.page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  await test.step('a forfeit: the end screen shows the real coin change for both', async () => {
    await startMatch(a, b);
    b.page.once('dialog', (d) => void d.accept());
    await b.page.getByRole('button', { name: 'Forfeit' }).click();
    await expect(a.page.getByTestId('coin-change')).toContainText('+50 coins', { timeout: 20_000 });
    await expect(a.page.getByTestId('coin-change')).toContainText('now 450');
    await expect(b.page.getByTestId('coin-change')).toContainText('−50 coins', { timeout: 20_000 });
    await a.page.screenshot({ path: `${SHOTS}/p4-end-screen.png` });
  });

  await test.step('the leaderboard ranks the winner above the loser', async () => {
    await a.page.goto('/leaderboard');
    const rows = a.page.getByRole('row');
    const winner = rows.filter({ hasText: a.username });
    await expect(winner).toContainText('450');
    await expect(winner).toContainText('(you)');
    const friends = a.page.getByRole('tab', { name: 'Friends' });
    await friends.click();
    const panel = a.page.getByRole('tabpanel');
    // only the two of us (just became friends): winner first
    await expect(panel.getByRole('row').nth(1)).toContainText(a.username, { timeout: 15_000 });
    await expect(panel.getByRole('row').nth(2)).toContainText(b.username);
    await a.page.screenshot({ path: `${SHOTS}/p4-leaderboard.png` });
  });

  await test.step('profile: stats, coin chart and history with the delta', async () => {
    await b.page.goto(`/u/${b.username}`);
    await expect(b.page.getByText('Coins', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByRole('img', { name: /Coins over your last/ })).toBeVisible();
    const history = b.page.getByRole('listitem').filter({ hasText: `vs @${a.username}` });
    await expect(history).toContainText('Lost');
    await expect(history).toContainText('−50');
    await b.page.screenshot({ path: `${SHOTS}/p4-profile.png`, fullPage: true });

    // someone else's profile: stats, no history
    await b.page.goto(`/u/${a.username}`);
    await expect(b.page.getByRole('heading', { name: /Level 1/ })).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByText('Match history')).toHaveCount(0);
  });

  await test.step('notification centre: the result is there, mark all read clears the badge', async () => {
    const bell = b.page.getByRole('button', { name: /^Notifications/ });
    await bell.click();
    const panel = b.page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toContainText(`You lost vs @${a.username}`, { timeout: 15_000 });
    await expect(panel).toContainText('-50 coins');
    await panel.getByRole('button', { name: 'Mark all read' }).click();
    await expect(b.page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });
});
