import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Phase 2 admin authoring through the UI: a problem setter writes a statement, uploads packed test
 * files, adds reference solutions, calibrates through the judge (fake-judge0 in dev) and publishes.
 * Needs the Phase 1 stack plus problem-service and judge-service (API + worker) and fake-judge0.
 */
const INBOX = process.env.NOTIFICATION_URL ?? 'http://localhost:4003';
const REPO = resolve(import.meta.dirname, '../../..');
const SHOTS = 'test-results/screens';
const run = Date.now().toString(36).slice(-5);
const PASSWORD = 'Sup3r-secret-pw';
const setter = { username: `setter_${run}`, email: `setter_${run}@e2e.test` };

async function verificationLink(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${INBOX}/internal/dev/inbox?to=${encodeURIComponent(email)}`);
    const { items } = (await r.json()) as { items: { subject: string; text: string }[] };
    const link = items
      .find((m) => m.subject.includes('Verify'))
      ?.text.match(/https?:\/\/\S+verify-email\?token=[\w-]+/)?.[0];
    if (link) return link;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no verification email for ${email}`);
}

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill(setter.username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/friends/);
}

const text = (name: string, body: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });

/** Packed files for fake-judge0's `program=sum-cases` (prints a+b per case). */
const FILES = [
  { kind: 'sample', input: '2\n1 2\n3 4\n', output: '3\n7\n' },
  { kind: 'small', input: '3\n0 0\n-1 1\n5 5\n', output: '0\n0\n10\n' },
  { kind: 'large', input: '2\n1000000 1000000\n7 8\n', output: '2000000\n15\n' },
];

const slot = (page: Page, ordinal: number): Locator =>
  page.getByRole('region', { name: `Test file ${ordinal}` });

test('Phase 2: author, calibrate and publish a problem in the admin UI', async ({ page }) => {
  test.setTimeout(180_000);

  await test.step('a regular user is turned away from /admin', async () => {
    await page.goto('/register');
    await page.getByLabel('Full name').fill('Setter Tester');
    await page.getByLabel('Username').fill(setter.username);
    await page.getByLabel('Email').fill(setter.email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(/\/friends/);
    const link = new URL(await verificationLink(setter.email));
    await page.goto(link.pathname + link.search);
    await expect(page.getByText('Your email is verified')).toBeVisible();

    await page.goto('/admin/problems');
    await expect(page.getByText('Problem setters only')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Problems' })).toHaveCount(0);
  });

  await test.step('with the problem_setter role the Problems section appears', async () => {
    // the username is generated above ([a-z0-9_] only), so the command string is safe
    execSync(`pnpm --filter @cb/identity-service set-role ${setter.username} problem_setter`, {
      cwd: REPO,
      stdio: 'ignore',
    });
    await page.getByRole('button', { name: 'Log out' }).click();
    await login(page); // the access token carries the role
    await page.getByRole('link', { name: 'Problems' }).click();
    await expect(page.getByRole('heading', { name: 'Problems', level: 1 })).toBeVisible();
  });

  await test.step('write the statement with a live markdown preview', async () => {
    await page.getByRole('link', { name: 'New problem' }).click();
    await page.getByLabel('Title').fill('Pair sums');
    await page.getByLabel('Slug').fill(`pair-sums-${run}`);
    await page.getByLabel('Statement', { exact: true }).fill('Print $a + b$ for **each** pair.');
    await page
      .getByLabel('Input format', { exact: true })
      .fill('The first line has $t$. Then $t$ lines `a b`.');
    await page.getByLabel('Output format', { exact: true }).fill('One line per case.');
    await page.getByLabel('Constraints').fill('$1 \\le t \\le 10^5$\n$|a|, |b| \\le 10^9$');
    await page.getByLabel('Input 1').fill('2\n1 2\n3 4');
    await page.getByLabel('Output 1').fill('3\n7');

    await page
      .getByRole('group', { name: 'Statement view' })
      .getByRole('button', { name: 'Preview' })
      .click();
    await expect(page.locator('.markdown strong')).toHaveText('each');
    await expect(page.locator('.markdown .katex').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/10-admin-new-problem.png`, fullPage: true });

    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(/\/admin\/problems\/[\w-]+\?tab=tests/);
    await expect(page.getByRole('heading', { name: 'Pair sums', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Publish blockers')).toContainText('Upload a sample test file');
  });

  await test.step('upload three packed test files (a bad one is explained)', async () => {
    const s1 = slot(page, 1);
    await s1.getByRole('button', { name: 'Upload' }).click();
    await s1.getByLabel('Input file').setInputFiles(text('1.in', '2\n1 2\n3 4\n'));
    await s1.getByLabel('Expected output file').setInputFiles(text('1.out', '3\n'));
    await s1.getByRole('button', { name: 'Save file 1' }).click();
    await expect(s1.getByRole('alert')).toBeVisible(); // 2 cases but 1 output line

    for (const [i, f] of FILES.entries()) {
      const s = slot(page, i + 1);
      if (i > 0) await s.getByRole('button', { name: 'Upload' }).click();
      await s.getByLabel('Kind').selectOption(f.kind);
      await s.getByLabel('Input file').setInputFiles(text(`${i + 1}.in`, f.input));
      await s.getByLabel('Expected output file').setInputFiles(text(`${i + 1}.out`, f.output));
      await s.getByRole('button', { name: `Save file ${i + 1}` }).click();
      await expect(s.getByText('Cases', { exact: true })).toBeVisible();
    }
    await expect(page.getByLabel('Publish blockers')).not.toContainText('test file');
  });

  await test.step('add an accepted C++ reference and a must-TLE brute force', async () => {
    await page.getByRole('tab', { name: /References/ }).click();
    const add = async (verdict: string, code: string) => {
      await page.getByLabel('Language').selectOption('cpp');
      await page.getByLabel('Expected verdict').selectOption(verdict);
      await page.getByLabel('Code', { exact: true }).fill(code);
      await page.getByRole('button', { name: 'Add reference' }).click();
      await expect(page.getByText(`expects ${verdict}`)).toBeVisible();
    };
    await add('AC', '// @fake program=sum-cases time=0.2\nint main() {}');
    await add('TLE', '// @fake program=sum-cases time=20\nint main() {}');
    await expect(page.getByLabel('Publish blockers')).toContainText('Run calibration');
  });

  await test.step('calibrate through the judge and see the limits', async () => {
    await page.getByRole('tab', { name: /Calibration/ }).click();
    await page.getByRole('button', { name: 'Run calibration' }).click();
    await expect(page.getByText(/Calibration passed/)).toBeVisible({ timeout: 90_000 });
    const limits = page.getByRole('table', { name: 'Time limits in use' });
    await expect(limits.getByRole('row', { name: /C\+\+/ })).toContainText('1000 ms');
    await expect(page.getByRole('table', { name: /Reference runs/ })).toContainText('TLE');
    await page.screenshot({ path: `${SHOTS}/11-admin-calibrated.png`, fullPage: true });
  });

  await test.step('publish', async () => {
    await expect(page.getByText('Everything is ready')).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('published', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0);

    const r = await page.request.get(`/api/v1/problems/pair-sums-${run}`);
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ title: 'Pair sums', timeLimitsMs: { cpp: 1000 } });
  });

  await test.step('statement edits keep it published; a memory change sends it back to draft', async () => {
    await page.getByRole('tab', { name: /Statement/ }).click();
    await page.getByLabel('Title').fill('Pair sums!');
    await page.getByRole('button', { name: 'Save statement' }).click();
    await expect(page.getByRole('heading', { name: 'Pair sums!', level: 1 })).toBeVisible();
    await expect(page.getByText('published', { exact: true })).toBeVisible();

    await page.getByLabel('Memory limit (MB)').fill('128');
    await expect(page.getByText(/needs calibration again/)).toBeVisible();
    await page.getByRole('button', { name: 'Save statement' }).click();
    await expect(page.getByText('draft', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Publish blockers')).toContainText('Run calibration');
  });
});
