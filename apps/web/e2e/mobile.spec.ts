import { expect, test, type Page } from '@playwright/test';
import { player, startMatch } from './support';

/**
 * Plan §21.5: everything works on a phone, the battle room included. Every page is checked for
 * horizontal overflow (nothing may stick out past the viewport), and the battle room's
 * Problem / Code tabs are exercised.
 */
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };

/**
 * The page must not scroll sideways. Content inside its own scroller (the code editor's long lines)
 * is fine, so offenders are only listed when the page itself is wider than the screen, and only
 * those not clipped by a scrolling ancestor.
 */
async function noOverflow(page: Page, label: string) {
  const wide = await page.evaluate(() => {
    const doc = document.documentElement;
    if (doc.scrollWidth <= doc.clientWidth) return [];
    const clipped = (e: Element) => {
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return true;
      }
      return false;
    };
    const out = [...document.querySelectorAll('body *')].filter(
      (e) => e.getBoundingClientRect().right > doc.clientWidth + 1,
    );
    return [...out.filter((e) => !clipped(e)), ...out.filter(clipped)]
      .slice(0, 6)
      .map(
        (e) =>
          `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 60)}${clipped(e) ? ' (in a scroller)' : ''} right=${Math.round(e.getBoundingClientRect().right)}`,
      )
      .concat(`page is ${doc.scrollWidth}px wide on a ${doc.clientWidth}px screen`);
  });
  expect(wide, `${label}: the page scrolls sideways`).toEqual([]);
}

test('phone layout: no page overflows; the battle room works with tabs @mobile', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await player(browser, 'pho', PHONE);
  const b = await player(browser, 'phob');

  for (const path of ['/', '/lobby', '/friends', '/leaderboard', '/notifications', `/u/${a.username}`]) {
    await a.page.goto(path);
    await a.page.waitForLoadState('networkidle');
    await noOverflow(a.page, path);
  }

  await startMatch(a, b);
  await expect(a.page.getByText('Battles are best on a bigger screen')).toBeVisible();
  await a.page.getByRole('tab', { name: 'code' }).click();
  await expect(a.page.getByRole('button', { name: /Submit/ })).toBeVisible();
  await noOverflow(a.page, 'battle room (code)');
  await a.page.getByRole('tab', { name: 'problem' }).click();
  await expect(a.page.getByRole('heading', { level: 1 })).toBeVisible();

  b.page.once('dialog', (d) => void d.accept());
  await b.page.getByRole('button', { name: 'Forfeit' }).click();
  await expect(a.page.getByTestId('coin-change')).toContainText('+50', { timeout: 20_000 });
  await noOverflow(a.page, 'end screen');

  // the profile with a match: donut, heatmap, chart, history
  await a.page.goto(`/u/${a.username}`);
  await expect(a.page.getByRole('img', { name: /win rate/ })).toBeVisible({ timeout: 15_000 });
  await expect(a.page.getByText(/1 match on 1 day/)).toBeVisible();
  await noOverflow(a.page, 'profile with history');
});
