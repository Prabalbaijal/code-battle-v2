import { expect, test } from '@playwright/test';
import { player, SHOTS, startMatch, typeCode } from './support';

/**
 * Phase 3 DoD (plan §25): two browsers play full matches through the real stack — lobby →
 * challenge → accept → battle room → a win by Accepted, and a win by forfeit. The judge is
 * fake-judge0 (`# @fake program=sum-cases` makes a Python program print the right sums).
 * Needs every service (incl. battle, realtime) running, notification with EMAIL_PROVIDER=fake.
 */
test('Phase 3 DoD: two players, one solves it first and wins; then a forfeit', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await player(browser, 'ana');
  const b = await player(browser, 'ben');

  await test.step('lobby → challenge → accept → battle room for both', async () => {
    await startMatch(a, b);
    await expect(b.page.getByRole('heading', { level: 1 })).toBeVisible(); // the problem title
    await b.page.screenshot({ path: `${SHOTS}/20-battle-room.png` });
  });

  await test.step('the opponent sees activity; an Accepted submission wins the match', async () => {
    await typeCode(a.page, 'python', '# @fake program=sum-cases wrongCase=1\nprint("almost")\n');
    await a.page.getByRole('button', { name: 'Submit' }).click();
    await expect(a.page.getByText('Wrong answer').first()).toBeVisible({ timeout: 30_000 });
    await expect(b.page.getByText(/submission: Wrong answer/).first()).toBeVisible({ timeout: 15_000 });

    await typeCode(b.page, 'python', '# @fake program=sum-cases\nprint("solved")\n');
    await b.page.keyboard.press('ControlOrMeta+Enter'); // the submit shortcut
    await expect(b.page.getByRole('heading', { name: 'You won!' })).toBeVisible({ timeout: 45_000 });
    await expect(a.page.getByRole('heading', { name: 'You lost' })).toBeVisible({ timeout: 15_000 });
    await expect(a.page.getByText('Your opponent solved it first.')).toBeVisible();
    await b.page.screenshot({ path: `${SHOTS}/21-victory.png` });
  });

  await test.step('a second match: forfeit gives the win to the other player', async () => {
    await a.page.getByRole('link', { name: 'Back to the lobby' }).click();
    await b.page.getByRole('link', { name: 'Back to the lobby' }).click();
    await startMatch(a, b);
    a.page.once('dialog', (d) => void d.accept());
    await a.page.getByRole('button', { name: 'Forfeit' }).click();
    await expect(a.page.getByText('You forfeited.')).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByText('Your opponent forfeited.')).toBeVisible({ timeout: 15_000 });
  });
});
