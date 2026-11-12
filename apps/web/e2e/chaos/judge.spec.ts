import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { player, startMatch, typeCode } from '../support';
import { chaosEnabled, judgeFaults, judgeHeal, note, since } from './infra';

/**
 * Chaos drill 4 (plan §18.6): the judge starts failing (fake-judge0 answers 500). The circuit
 * breaker opens, new challenges are refused with a clear message, a match whose clock runs out
 * with a submission still unjudged goes to `deciding` instead of ending wrongly, and once the judge
 * is back the pending submission is judged and decides the match.
 * Needs battle-service with MATCH_DURATION_SECONDS=60 (E2E_SHORT_MATCH=1).
 */
test('drill 4: the judge fails mid-match', async ({ browser }) => {
  chaosEnabled();
  test.skip(process.env.E2E_SHORT_MATCH !== '1', 'needs MATCH_DURATION_SECONDS=60 (E2E_SHORT_MATCH=1)');
  test.setTimeout(420_000);
  const a = await player(browser, 'jud');
  const b = await player(browser, 'judb');
  // c challenges d (both idle): the only reason left to refuse is the judge
  const c = await player(browser, 'judc');
  const d = await player(browser, 'judd');
  await startMatch(a, b);

  await judgeFaults(500, 1_000_000);
  const t0 = Date.now();
  note('judge failing', 'every Judge0 call → 500');
  let healed = false;
  try {
    // unique code: an identical earlier submission is answered from the verdict cache without
    // calling Judge0 at all
    await typeCode(a.page, 'python', `# @fake program=sum-cases\n# drill ${randomUUID()}\nprint("y")\n`);
    await a.page.getByRole('button', { name: 'Submit' }).click();
    await expect(a.page.getByText('Judging…').first()).toBeVisible({ timeout: 30_000 });
    note('submission', 'accepted, stays unjudged while the judge fails');

    // breaker open → admission control refuses new matches, with a message that says why
    const target = (await (await c.page.request.get(`/api/v1/users/${d.username}`)).json()) as { id: string };
    await expect
      .poll(
        async () => {
          // a reused keep-alive socket can be reset by the server mid-poll: just ask again
          const r = await c.page.request
            .post('/api/v1/challenges', {
              headers: { 'x-cb-csrf': '1', 'idempotency-key': randomUUID() },
              data: { toUserId: target.id },
            })
            .catch(() => null);
          if (!r) return 'network error';
          if (r.status() === 201) {
            // still let through (the breaker isn't open yet): withdraw it and ask again later
            const { id } = (await r.json()) as { id: string };
            await c.page.request.post(`/api/v1/challenges/${id}/cancel`, { headers: { 'x-cb-csrf': '1' } });
            return 'not refused yet';
          }
          if (r.status() !== 503) return r.status();
          return ((await r.json()) as { error: { message: string } }).error.message;
        },
        { timeout: 120_000, intervals: [5_000] },
      )
      .toBe('The judge is unavailable right now. Try again soon.');
    note('new challenges refused after', since(t0));

    // the clock runs out with a submission unjudged: deciding, not a wrong result
    await expect(a.page.getByText(/Deciding/)).toBeVisible({ timeout: 120_000 });
    note('match at ends_at', 'deciding (waits for the pending verdict)');

    await judgeHeal();
    healed = true;
    const t1 = Date.now();
    await expect(a.page.getByRole('heading', { name: 'You won!' })).toBeVisible({ timeout: 150_000 });
    await expect(b.page.getByRole('heading', { name: 'You lost' })).toBeVisible({ timeout: 30_000 });
    note('judge back → pending submission judged, match decided after', since(t1));
  } finally {
    if (!healed) await judgeHeal();
  }
});
