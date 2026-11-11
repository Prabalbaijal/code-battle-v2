import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { player, startMatch, typeCode } from './support';

/**
 * Chaos drill 2 (plan Phase 3 DoD): a realtime node dies mid-match. Clients reconnect with new
 * tickets, the match goes on (battle-service doesn't depend on realtime), and both players still
 * see the result. Set E2E_REALTIME_RESTART to a command that restarts the realtime node.
 */
test('chaos: the realtime node restarts mid-match and the match still finishes for both', async ({
  browser,
}) => {
  const restart = process.env.E2E_REALTIME_RESTART;
  test.skip(!restart, 'set E2E_REALTIME_RESTART to a command that restarts the realtime node');
  test.setTimeout(240_000);
  const a = await player(browser, 'chaosa');
  const b = await player(browser, 'chaosb');
  await startMatch(a, b);

  execSync(restart!, { stdio: 'ignore' });

  // the opponent's activity needs a live socket again, so seeing it proves the reconnect
  let attempt = 0;
  await expect(async () => {
    // new code each try: identical resubmissions are refused (CODE_UNCHANGED)
    await typeCode(
      a.page,
      'python',
      `# @fake program=sum-cases wrongCase=1
print(${++attempt})
`,
    );
    await a.page.getByRole('button', { name: 'Submit' }).click();
    await expect(b.page.getByText(/submission: Wrong answer/).first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000, intervals: [6_000] });

  await typeCode(b.page, 'python', '# @fake program=sum-cases\nprint("y")\n');
  await b.page.getByRole('button', { name: 'Submit' }).click();
  await expect(b.page.getByRole('heading', { name: 'You won!' })).toBeVisible({ timeout: 45_000 });
  await expect(a.page.getByRole('heading', { name: 'You lost' })).toBeVisible({ timeout: 15_000 });
});
