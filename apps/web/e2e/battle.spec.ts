import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Phase 3 DoD (plan §25): two browsers play full matches through the real stack — lobby →
 * challenge → accept → battle room → a win by Accepted, and a win by forfeit. The judge is
 * fake-judge0 (`# @fake program=sum-cases` makes a Python program print the right sums).
 * Needs every service (incl. battle, realtime) running, notification with EMAIL_PROVIDER=fake.
 */
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const INBOX = process.env.NOTIFICATION_URL ?? 'http://localhost:4003';
const PASSWORD = 'Sup3r-secret-pw';
const run = Date.now().toString(36).slice(-5);
const SHOTS = 'test-results/screens';

interface Player {
  username: string;
  page: Page;
}

/** Register and verify through the API (the UI flow is covered in phase1.spec), then log in. */
async function player(browser: Browser, name: string): Promise<Player> {
  const username = `${name}_${run}`;
  const email = `${username}@e2e.test`;
  const headers = {
    origin: WEB,
    'content-type': 'application/json',
    'x-cb-csrf': '1',
    'idempotency-key': crypto.randomUUID(),
  };
  const reg = await fetch(`${WEB}/api/v1/auth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, fullname: `${name} Tester`, email, password: PASSWORD }),
  });
  expect(reg.status, await reg.clone().text()).toBe(201);
  let token: string | undefined;
  for (let i = 0; i < 40 && !token; i++) {
    const r = await fetch(`${INBOX}/internal/dev/inbox?to=${encodeURIComponent(email)}`);
    const { items } = (await r.json()) as { items: { text: string }[] };
    token = items.map((m) => m.text.match(/verify-email\?token=([\w-]+)/)?.[1]).find(Boolean);
    if (!token) await new Promise((res) => setTimeout(res, 500));
  }
  const v = await fetch(`${WEB}/api/v1/auth/verify-email`, {
    method: 'POST',
    headers: { origin: WEB, 'content-type': 'application/json', 'x-cb-csrf': '1' },
    body: JSON.stringify({ token }),
  });
  expect(v.ok).toBe(true);

  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/friends/);
  return { username, page };
}

/** A challenges B from the lobby (search), B accepts in the modal; both end up in the room. */
async function startMatch(a: Player, b: Player) {
  await b.page.goto('/lobby');
  await a.page.goto('/lobby');
  await expect(a.page.getByText(/\d+ online/)).toBeVisible({ timeout: 20_000 });
  await a.page.getByLabel('Search online players by username').fill(b.username);
  const row = a.page.getByRole('listitem').filter({ hasText: b.username });
  await row.getByRole('button', { name: 'Challenge' }).click();

  const dialog = b.page.getByRole('alertdialog');
  await expect(dialog).toContainText(`${a.username} challenges you`, { timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Accept' }).click();

  for (const p of [a, b]) await expect(p.page).toHaveURL(/\/battle\/[\w-]+/, { timeout: 20_000 });
  for (const p of [a, b]) await expect(p.page.getByRole('timer')).toBeVisible();
}

async function typeCode(p: Page, language: string, code: string) {
  await p.getByLabel('Language').selectOption(language);
  const editor = p.locator('.cm-content');
  await editor.click();
  await p.keyboard.press('ControlOrMeta+a');
  await p.keyboard.insertText(code);
}

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
