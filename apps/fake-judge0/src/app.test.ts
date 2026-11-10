import { createLogger } from '@cb/logger';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFakeJudge0 } from './app.js';
import { parseDirectives, runProgram } from './directives.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const unb64 = (s: string | null) => (s === null ? null : Buffer.from(s, 'base64').toString());
let app: Awaited<ReturnType<typeof buildFakeJudge0>> | undefined;
afterEach(async () => app?.close());

describe('directives', () => {
  it('parses keys, quoted values and escapes', () => {
    expect(parseDirectives('// @fake status=TLE time=2.3 stdout="a\\nb" program=echo')).toEqual({
      status: 5,
      time: 2.3,
      stdout: 'a\nb',
      program: 'echo',
    });
    expect(() => parseDirectives('# @fake status=NOPE')).toThrow();
    expect(runProgram('sum-cases', '2\n1 2\n10 20 30\n')).toBe('3\n60\n');
  });
});

describe('fake judge0 API', () => {
  it('runs a batch with base64 and reports per-item results and validation errors', async () => {
    app = await buildFakeJudge0({ logger });
    const res = await app.inject({
      method: 'POST',
      url: '/submissions/batch?base64_encoded=true',
      payload: {
        submissions: [
          { source_code: b64('# @fake program=sum-cases'), language_id: 71, stdin: b64('1\n2 3\n') },
          { source_code: b64('// @fake status=CE'), language_id: 54 },
          { source_code: b64('x'), language_id: 999 },
          { source_code: b64('// @fake time=3'), language_id: 54, cpu_time_limit: 2, cpu_extra_time: 0.5 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const items = res.json() as Array<{ token?: string; language_id?: string[] }>;
    expect(items[2]!.language_id?.[0]).toContain("doesn't exist");
    const tokens = [items[0]!.token, items[1]!.token, items[3]!.token].join(',');

    const got = await app.inject({
      method: 'GET',
      url: `/submissions/batch?tokens=${tokens}&base64_encoded=true&fields=token,status,stdout,compile_output,time,memory`,
    });
    const [ok, ce, tle] = got.json().submissions;
    expect(ok.status.id).toBe(3);
    expect(unb64(ok.stdout)).toBe('5\n');
    expect(ce.status.id).toBe(6);
    expect(unb64(ce.compile_output)).toContain('error');
    expect(tle.status.id).toBe(5);
    expect(tle.time).toBe('2.500'); // capped at cpu_time_limit + cpu_extra_time
  });

  it('like Judge0 CE, a run with fewer than 2 processes dies in the forking wrapper (RE)', async () => {
    app = await buildFakeJudge0({ logger });
    const run = async (max: number) => {
      const created = await app!.inject({
        method: 'POST',
        url: '/submissions',
        payload: {
          source_code: '# @fake program=sum-cases',
          language_id: 71,
          stdin: '1\n2 3\n',
          max_processes_and_or_threads: max,
        },
      });
      const { token } = created.json() as { token: string };
      const r = await app!.inject({
        method: 'GET',
        url: `/submissions/${token}?fields=status,stderr,message`,
      });
      return r.json() as { status: { id: number }; stderr: string | null; message: string | null };
    };
    const one = await run(1);
    expect([one.status.id, one.message]).toEqual([11, 'Exited with error status 254']);
    expect(one.stderr).toContain('fork: retry: Resource temporarily unavailable');
    expect((await run(60)).status.id).toBe(3);
  });

  it('reports In Queue → Processing → final according to delay', async () => {
    let now = 0;
    app = await buildFakeJudge0({ logger, now: () => now });
    const { token } = (
      await app.inject({
        method: 'POST',
        url: '/submissions',
        payload: { source_code: '// @fake delay=1000', language_id: 54 },
      })
    ).json();
    const status = async () =>
      (await app!.inject({ method: 'GET', url: `/submissions/${token}` })).json().status.id;
    expect(await status()).toBe(1);
    now = 600;
    expect(await status()).toBe(2);
    now = 1000;
    expect(await status()).toBe(3);
  });

  it('compares expected_output like Judge0 (WA) and rejects limits above maxima', async () => {
    app = await buildFakeJudge0({ logger });
    const wa = await app.inject({
      method: 'POST',
      url: '/submissions',
      payload: { source_code: '// @fake stdout="1"', language_id: 54, expected_output: '2' },
    });
    const got = await app.inject({ method: 'GET', url: `/submissions/${wa.json().token}` });
    expect(got.json().status.id).toBe(4);
    const tooBig = await app.inject({
      method: 'POST',
      url: '/submissions',
      payload: { source_code: 'x', language_id: 54, cpu_time_limit: 99 },
    });
    expect(tooBig.statusCode).toBe(422);
    expect(tooBig.json().cpu_time_limit).toBeDefined();
  });

  it('injects faults and counts calls', async () => {
    app = await buildFakeJudge0({ logger });
    await app.inject({
      method: 'POST',
      url: '/__fake/faults',
      payload: { status: 429, count: 1, retryAfter: 2 },
    });
    const limited = await app.inject({
      method: 'POST',
      url: '/submissions',
      payload: { source_code: 'x', language_id: 54 },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('2');
    const ok = await app.inject({
      method: 'POST',
      url: '/submissions',
      payload: { source_code: 'x', language_id: 54 },
    });
    expect(ok.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/__fake/stats' })).json()).toMatchObject({ created: 1 });
  });

  it('PUTs the result to callback_url and retries on failure', async () => {
    const calls: Array<{ url: string; body: { status: { id: number } } }> = [];
    let fail = true;
    app = await buildFakeJudge0({
      logger,
      callbackRetryMs: 10,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        if (fail) {
          fail = false;
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await app.inject({
      method: 'POST',
      url: '/submissions',
      payload: {
        source_code: '// @fake status=TLE',
        language_id: 54,
        callback_url: 'http://judge-service/hooks/judge0/r1?sig=x',
      },
    });
    // poll instead of a fixed sleep: timers can lag when the whole monorepo is testing in parallel
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('/hooks/judge0/r1');
    expect(calls[1]!.body.status.id).toBe(5);
  });
});
