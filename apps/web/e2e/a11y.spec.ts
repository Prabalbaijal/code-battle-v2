import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { player, startMatch } from './support';

/**
 * Phase 5 DoD: axe finds no serious or critical issues on any page, in both colour schemes
 * (the design is dark-first; light is the other half). WCAG 2.1 A/AA rules.
 */
async function audit(page: Page, label: string) {
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const report = bad.map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help}\n` +
        v.nodes
          .slice(0, 5)
          .map((n) => `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(1).join(' ').trim()}`)
          .join('\n'),
    );
    expect(report, `${label} (${colorScheme})`).toEqual([]);
  }
}

test('accessibility: no serious axe issues on any page', async ({ browser }) => {
  test.setTimeout(480_000); // ~14 pages × 2 colour schemes
  const a = await player(browser, 'ally');
  const b = await player(browser, 'bea');

  await test.step('signed out', async () => {
    const page = await (await browser.newContext()).newPage();
    for (const path of ['/', '/login', '/register', '/forgot-password', '/leaderboard', `/u/${a.username}`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await audit(page, path);
    }
  });

  await test.step('signed in pages', async () => {
    for (const path of ['/lobby', '/friends', '/notifications', '/leaderboard', `/u/${a.username}`]) {
      await a.page.goto(path);
      await a.page.waitForLoadState('networkidle');
      await audit(a.page, path);
    }
    await a.page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(a.page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await audit(a.page, 'notification panel');
  });

  await test.step('battle room and end screen', async () => {
    await startMatch(a, b);
    await a.page.waitForLoadState('networkidle');
    await audit(a.page, 'battle room');
    b.page.once('dialog', (d) => void d.accept());
    await b.page.getByRole('button', { name: 'Forfeit' }).click();
    await expect(a.page.getByTestId('coin-change')).toBeVisible({ timeout: 20_000 });
    await audit(a.page, 'end screen');
    await a.page.goto(`/u/${a.username}`);
    await expect(a.page.getByRole('img', { name: /Coins over your last/ })).toBeVisible({ timeout: 15_000 });
    await audit(a.page, 'own profile with history');
  });
});
