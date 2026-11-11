import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Phase 1 Definition of Done (plan §25): register → verification email (fake inbox) → verify →
 * login → refresh rotation → send, accept and remove a friend. Runs in real browsers through
 * Next.js → gateway → services.
 */
const INBOX = process.env.NOTIFICATION_URL ?? 'http://localhost:4003';
const SHOTS = 'test-results/screens';
const run = Date.now().toString(36).slice(-5);
const PASSWORD = 'Sup3r-secret-pw';

interface Player {
  username: string;
  fullname: string;
  email: string;
}
const player = (name: string): Player => ({
  username: `${name}_${run}`,
  fullname: `${name[0]!.toUpperCase()}${name.slice(1)} Tester`,
  email: `${name}_${run}@e2e.test`,
});

/** Poll the notification service's fake inbox for the verification link. */
async function verificationLink(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${INBOX}/internal/dev/inbox?to=${encodeURIComponent(email)}`);
    const { items } = (await r.json()) as { items: { subject: string; text: string }[] };
    const mail = items.find((m) => m.subject.includes('Verify'));
    const link = mail?.text.match(/https?:\/\/\S+verify-email\?token=[\w-]+/)?.[0];
    if (link) return link;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no verification email for ${email}`);
}

async function register(page: Page, p: Player) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(p.fullname);
  await page.getByLabel('Username').fill(p.username);
  await page.getByLabel('Email').fill(p.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/friends/);
  await expect(page.getByText(`Verify ${p.email}`)).toBeVisible();
}

async function verify(page: Page, p: Player) {
  const link = new URL(await verificationLink(p.email));
  await page.goto(link.pathname + link.search); // the email points at WEB_BASE_URL; stay on our base
  await expect(page.getByText('Your email is verified')).toBeVisible();
  await page.getByRole('link', { name: 'Go to friends' }).click();
  await expect(page.getByText(/to send friend requests and play/)).toHaveCount(0);
}

const cookie = async (ctx: BrowserContext, name: string) =>
  (await ctx.cookies()).find((c) => c.name === name);

test('Phase 1 DoD: register, verify, friends, refresh, logout', async ({ browser }) => {
  test.setTimeout(180_000); // a long two-user journey through the whole stack
  const alice = player('alice');
  const bob = player('bob');
  const ca = await browser.newContext();
  const cb = await browser.newContext();
  const a = await ca.newPage();
  const b = await cb.newPage();

  await test.step('landing renders', async () => {
    await a.goto('/');
    await expect(a.getByRole('heading', { level: 1 })).toContainText('Out-code your friends');
    await a.screenshot({ path: `${SHOTS}/01-landing.png`, fullPage: true });
  });

  await test.step('register both players (lands on /friends with the verify banner)', async () => {
    await register(a, alice);
    await a.screenshot({ path: `${SHOTS}/02-friends-unverified.png`, fullPage: true });
    await register(b, bob);
    expect(await cookie(ca, 'cb_at')).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    expect(await cookie(ca, 'cb_rt')).toMatchObject({ httpOnly: true, path: '/api/v1/auth' });
  });

  await test.step('unverified users cannot send requests', async () => {
    await a.goto('/friends?tab=find');
    await a.getByLabel('Search players by username').fill(bob.username);
    await a.getByRole('button', { name: 'Add' }).click();
    await expect(a.getByText('Verify your email first')).toBeVisible();
  });

  await test.step('verify emails from the fake inbox', async () => {
    await verify(a, alice);
    await verify(b, bob);
  });

  await test.step('Alice finds Bob and sends a request', async () => {
    await a.goto('/friends?tab=find');
    await a.getByLabel('Search players by username').fill(bob.username.slice(0, 7));
    const row = a.getByRole('listitem').filter({ hasText: `@${bob.username}` });
    await expect(row).toBeVisible();
    await a.screenshot({ path: `${SHOTS}/03-search.png`, fullPage: true });
    await row.getByRole('button', { name: 'Add' }).click();
    await expect(row.getByText('Requested')).toBeVisible();
  });

  await test.step('Bob accepts from the Requests tab', async () => {
    await b.goto('/friends?tab=requests');
    const row = b.getByRole('listitem').filter({ hasText: `@${alice.username}` });
    await expect(row).toBeVisible();
    await b.screenshot({ path: `${SHOTS}/04-requests.png`, fullPage: true });
    await row.getByRole('button', { name: 'Accept' }).click();
    await b.getByRole('tab', { name: 'Friends' }).click();
    await expect(b.getByRole('listitem').filter({ hasText: `@${alice.username}` })).toBeVisible();
  });

  await test.step('profile shows the relationship', async () => {
    await a.goto(`/u/${bob.username}`);
    await expect(a.getByRole('heading', { name: bob.fullname })).toBeVisible();
    const card = a.getByRole('main');
    await expect(card.getByText('Friends', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Remove' })).toBeVisible();
    await a.screenshot({ path: `${SHOTS}/05-profile.png`, fullPage: true });
  });

  await test.step('an expired access cookie is refreshed transparently (rotation)', async () => {
    const before = await cookie(ca, 'cb_rt');
    await ca.clearCookies({ name: 'cb_at' });
    await a.goto('/friends');
    await expect(a.getByRole('listitem').filter({ hasText: `@${bob.username}` })).toBeVisible();
    expect(await cookie(ca, 'cb_at')).toBeTruthy();
    expect((await cookie(ca, 'cb_rt'))?.value).not.toBe(before?.value);
    await a.screenshot({ path: `${SHOTS}/06-friends.png`, fullPage: true });
  });

  await test.step('Alice removes Bob', async () => {
    const row = a.getByRole('listitem').filter({ hasText: `@${bob.username}` });
    await row.getByRole('button', { name: `Remove ${bob.username}` }).click();
    await expect(a.getByText('No friends yet')).toBeVisible();
  });

  await test.step('logout clears the session; protected pages redirect to login', async () => {
    await a.getByRole('button', { name: 'Log out' }).click();
    await expect(a.getByRole('link', { name: 'Log in' })).toBeVisible();
    expect(await cookie(ca, 'cb_s')).toBeUndefined();
    await a.goto('/friends');
    await expect(a).toHaveURL(/\/login\?next=%2Ffriends/);
    await a.screenshot({ path: `${SHOTS}/07-login.png`, fullPage: true });
  });

  await test.step('log back in and land where we were going', async () => {
    await a.getByLabel('Username or email').fill(alice.email);
    await a.getByLabel('Password').fill(PASSWORD);
    await a.getByRole('button', { name: 'Log in' }).click();
    await expect(a).toHaveURL(/\/friends$/);
  });

  await ca.close();
  await cb.close();
});

test('mobile layout of the auth pages @mobile', async ({ page }) => {
  for (const [path, name] of [
    ['/login', 'login'],
    ['/register', 'register'],
    ['/', 'landing'],
  ] as const) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, `${path} scrolls horizontally`).toBe(false);
    await page.screenshot({ path: `${SHOTS}/m-${name}.png`, fullPage: true });
  }
});
