import { expect, type Browser, type Page } from '@playwright/test';

/** Shared helpers for the battle specs (real stack, fake-judge0). */
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const INBOX = process.env.NOTIFICATION_URL ?? 'http://localhost:4003';
const PASSWORD = 'Sup3r-secret-pw';
const run = Date.now().toString(36).slice(-5);
export const SHOTS = 'test-results/screens';

export interface Player {
  username: string;
  page: Page;
}

/** Register and verify through the API (the UI flow is covered in phase1.spec), then log in. */
export async function player(browser: Browser, name: string): Promise<Player> {
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
export async function startMatch(a: Player, b: Player) {
  await b.page.goto('/lobby');
  await a.page.goto('/lobby');
  // both sockets connected (the badge shows the online count once a socket is up)
  for (const p of [a, b]) await expect(p.page.getByText(/\d+ online/)).toBeVisible({ timeout: 20_000 });
  await a.page.getByLabel('Search online players by username').fill(b.username);
  const row = a.page.getByRole('listitem').filter({ hasText: b.username });
  await row.getByRole('button', { name: 'Challenge' }).click();

  const dialog = b.page.getByRole('alertdialog');
  await expect(dialog).toContainText(`${a.username} challenges you`, { timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Accept' }).click();

  for (const p of [a, b]) await expect(p.page).toHaveURL(/\/battle\/[\w-]+/, { timeout: 20_000 });
  for (const p of [a, b]) await expect(p.page.getByRole('timer')).toBeVisible();
}

export async function typeCode(p: Page, language: string, code: string) {
  await p.getByLabel('Language').selectOption(language);
  const editor = p.locator('.cm-content');
  await editor.click();
  await p.keyboard.press('ControlOrMeta+a');
  await p.keyboard.insertText(code);
}
