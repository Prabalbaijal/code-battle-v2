import { expect, test, type Page } from '@playwright/test';
import { player, startMatch } from './support';

/**
 * The Content-Security-Policy (next.config.ts) must not break anything: every page and a whole
 * battle (socket, KaTeX statement, lazy editor) run without a single violation.
 */
function watch(page: Page, into: string[]) {
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (load|connect|execute|apply)/i.test(m.text()))
      into.push(m.text());
  });
}

test('no CSP violations on any page or during a battle', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await player(browser, 'csp');
  const b = await player(browser, 'cspb');
  const violations: string[] = [];
  watch(a.page, violations);

  const res = await a.page.goto('/');
  expect(res?.headers()['content-security-policy'], 'the policy is sent').toContain("object-src 'none'");
  for (const path of ['/lobby', '/friends', '/leaderboard', '/notifications', `/u/${a.username}`]) {
    await a.page.goto(path);
    await a.page.waitForLoadState('networkidle');
  }
  await startMatch(a, b);
  await expect(a.page.locator('.katex').first()).toBeVisible({ timeout: 15_000 }); // maths rendered
  await expect(a.page.locator('.cm-content')).toBeVisible({ timeout: 15_000 }); // editor loaded
  b.page.once('dialog', (d) => void d.accept());
  await b.page.getByRole('button', { name: 'Forfeit' }).click();
  await expect(a.page.getByTestId('coin-change')).toBeVisible({ timeout: 20_000 }); // socket works
  expect(violations).toEqual([]);
});
