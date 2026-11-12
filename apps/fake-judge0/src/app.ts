import { createHttpServer, type HttpServer } from '@cb/http-server';
import type { Logger } from '@cb/logger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseDirectives, runProgram, type Directives } from './directives.js';
import { CONFIG_INFO, LANGUAGES, STATUSES, type StatusId } from './judge0.js';

const submissionInput = z
  .object({
    source_code: z.string(),
    language_id: z.number().int(),
    stdin: z.string().nullish(),
    expected_output: z.string().nullish(),
    cpu_time_limit: z.number().nullish(),
    cpu_extra_time: z.number().nullish(),
    wall_time_limit: z.number().nullish(),
    memory_limit: z.number().nullish(),
    stack_limit: z.number().nullish(),
    max_processes_and_or_threads: z.number().nullish(),
    enable_per_process_and_thread_time_limit: z.boolean().nullish(),
    max_file_size: z.number().nullish(),
    number_of_runs: z.number().nullish(),
    callback_url: z.string().url().nullish(),
  })
  .loose();
type SubmissionInput = z.infer<typeof submissionInput>;

const encodingQuery = z.object({
  base64_encoded: z.enum(['true', 'false']).optional(),
  fields: z.string().optional(),
});

interface Stored {
  token: string;
  createdAt: number;
  delay: number;
  base64: boolean;
  languageId: number;
  callbackUrl?: string;
  result: {
    statusId: StatusId;
    stdout: string | null;
    stderr: string | null;
    compileOutput: string | null;
    message: string | null;
    time: number | null;
    wallTime: number | null;
    memory: number | null;
  };
}

export interface FakeJudge0Options {
  logger: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
  callbackRetryMs?: number;
}

const b64 = (s: string | null, on: boolean) =>
  s === null ? null : on ? Buffer.from(s).toString('base64') : s;
const unb64 = (s: string | null | undefined, on: boolean) =>
  s == null ? '' : on ? Buffer.from(s, 'base64').toString('utf8') : s;

/** Build an in-memory fake of the Judge0 CE HTTP API (plan §14, §20). */
export async function buildFakeJudge0(opts: FakeJudge0Options): Promise<HttpServer> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  const store = new Map<string, Stored>();
  const stats = { created: 0, batches: 0, gets: 0, callbacks: 0 };
  let fault: { status: number; count: number; retryAfter?: number } | undefined;

  const app = await createHttpServer({
    serviceName: 'fake-judge0',
    logger: opts.logger,
    bodyLimit: 50 * 1024 * 1024,
  });

  // ---- fault injection applies to the Judge0 API routes only
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/submissions') || !fault || fault.count <= 0) return;
    fault.count--;
    if (fault.retryAfter !== undefined) reply.header('retry-after', String(fault.retryAfter));
    return reply.code(fault.status).send({ error: `injected fault ${fault.status}` });
  });

  function validate(input: SubmissionInput): Record<string, string[]> | undefined {
    const errors: Record<string, string[]> = {};
    if (!LANGUAGES.some((l) => l.id === input.language_id)) {
      errors.language_id = [`language with id ${input.language_id} doesn't exist`];
    }
    const checks: Array<[keyof SubmissionInput, number]> = [
      ['cpu_time_limit', CONFIG_INFO.max_cpu_time_limit],
      ['cpu_extra_time', CONFIG_INFO.max_cpu_extra_time],
      ['wall_time_limit', CONFIG_INFO.max_wall_time_limit],
      ['memory_limit', CONFIG_INFO.max_memory_limit],
      ['stack_limit', CONFIG_INFO.max_stack_limit],
      ['max_processes_and_or_threads', CONFIG_INFO.max_max_processes_and_or_threads],
      ['max_file_size', CONFIG_INFO.max_max_file_size],
    ];
    for (const [k, max] of checks) {
      const v = input[k];
      if (typeof v === 'number' && v > max) errors[k] = [`must be less than or equal to ${max}`];
    }
    return Object.keys(errors).length ? errors : undefined;
  }

  function execute(input: SubmissionInput, base64: boolean): Stored {
    const source = unb64(input.source_code, base64);
    const stdin = unb64(input.stdin, base64);
    const expected = input.expected_output == null ? undefined : unb64(input.expected_output, base64);
    let d: Directives;
    try {
      d = parseDirectives(source);
    } catch (err) {
      d = { status: 13, stderr: (err as Error).message };
    }
    const cpuLimit = input.cpu_time_limit ?? CONFIG_INFO.cpu_time_limit;
    const extra = input.cpu_extra_time ?? CONFIG_INFO.cpu_extra_time;
    let statusId: StatusId = d.status ?? 3;
    let time = d.time ?? (d.timePerKb !== undefined ? (Buffer.byteLength(stdin) / 1024) * d.timePerKb : 0.01);
    const stdout = d.stdout ?? runProgram(d.program, stdin, d.wrongCase);

    // Real Judge0 CE runs programs through a forking shell wrapper; too few processes kills it.
    const forkFails =
      statusId !== 6 && statusId !== 13 && statusId !== 14 && (input.max_processes_and_or_threads ?? 60) < 2;
    if (forkFails) {
      statusId = 11;
      time = 0.002;
    }
    if (statusId === 3 && time > cpuLimit) statusId = 5;
    if (statusId === 5) time = Math.min(Math.max(time, cpuLimit), cpuLimit + extra);
    if (statusId === 3 && expected !== undefined && stdout.trimEnd() !== expected.trimEnd()) statusId = 4;

    const compiled = statusId !== 6 && statusId !== 13 && statusId !== 14;
    const token = randomUUID();
    return {
      token,
      createdAt: now(),
      delay: d.delay ?? 0,
      base64,
      languageId: input.language_id,
      ...(input.callback_url ? { callbackUrl: input.callback_url } : {}),
      result: {
        statusId,
        stdout: compiled ? stdout : null,
        stderr: forkFails ? 'run.sh: fork: retry: Resource temporarily unavailable\n' : (d.stderr ?? null),
        compileOutput: statusId === 6 ? (d.compileOutput ?? 'main.cpp:1:1: error: fake compile error') : null,
        message: forkFails
          ? 'Exited with error status 254'
          : statusId >= 7 && statusId <= 12
            ? 'Exited with error status 1'
            : null,
        time: compiled ? time : null,
        wallTime: compiled ? (d.wall ?? time + 0.02) : null,
        memory: compiled ? (d.memory ?? 1024) : null,
      },
    };
  }

  function view(s: Stored, base64: boolean, fields?: string) {
    const elapsed = now() - s.createdAt;
    const done = elapsed >= s.delay;
    const statusId: StatusId = done ? s.result.statusId : elapsed < s.delay / 2 ? 1 : 2;
    const full: Record<string, unknown> = {
      token: s.token,
      status: { id: statusId, description: STATUSES[statusId] },
      status_id: statusId,
      language_id: s.languageId,
      stdout: done ? b64(s.result.stdout, base64) : null,
      stderr: done ? b64(s.result.stderr, base64) : null,
      compile_output: done ? b64(s.result.compileOutput, base64) : null,
      message: done ? b64(s.result.message, base64) : null,
      time: done && s.result.time !== null ? s.result.time.toFixed(3) : null,
      wall_time: done && s.result.wallTime !== null ? s.result.wallTime.toFixed(3) : null,
      memory: done ? s.result.memory : null,
      exit_code: done ? (statusId >= 7 && statusId <= 12 ? 1 : 0) : null,
    };
    const defaults = ['token', 'status', 'stdout', 'stderr', 'compile_output', 'message', 'time', 'memory'];
    const wanted =
      fields === '*' ? Object.keys(full) : fields ? fields.split(',').map((f) => f.trim()) : defaults;
    return Object.fromEntries(wanted.filter((f) => f in full).map((f) => [f, full[f]]));
  }

  function scheduleCallback(s: Stored) {
    if (!s.callbackUrl) return;
    const send = async (attempt: number): Promise<void> => {
      try {
        const res = await doFetch(s.callbackUrl!, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(view(s, s.base64, '*')),
          signal: AbortSignal.timeout(CONFIG_INFO.callbacks_timeout * 1000),
        });
        if (!res.ok) throw new Error(`callback responded ${res.status}`);
        stats.callbacks++;
      } catch (err) {
        if (attempt < CONFIG_INFO.callbacks_max_tries) {
          setTimeout(() => void send(attempt + 1), opts.callbackRetryMs ?? 1000).unref();
        } else opts.logger.warn({ err, token: s.token }, 'callback failed permanently');
      }
    };
    setTimeout(() => void send(1), s.delay).unref();
  }

  function create(input: SubmissionInput, base64: boolean): Stored {
    const s = execute(input, base64);
    store.set(s.token, s);
    stats.created++;
    scheduleCallback(s);
    return s;
  }

  app.get('/config_info', async () => CONFIG_INFO);
  app.get('/languages', async () => LANGUAGES);
  app.get('/statuses', async () =>
    Object.entries(STATUSES).map(([id, description]) => ({ id: Number(id), description })),
  );

  app.post(
    '/submissions',
    { schema: { querystring: encodingQuery, body: submissionInput } },
    async (req, reply) => {
      const base64 = req.query.base64_encoded === 'true';
      const errors = validate(req.body);
      if (errors) return reply.code(422).send(errors);
      const s = create(req.body, base64);
      return reply.code(201).send({ token: s.token });
    },
  );

  app.post(
    '/submissions/batch',
    { schema: { querystring: encodingQuery, body: z.object({ submissions: z.array(submissionInput) }) } },
    async (req, reply) => {
      const base64 = req.query.base64_encoded === 'true';
      const subs = req.body.submissions;
      if (subs.length === 0 || subs.length > CONFIG_INFO.max_submission_batch_size) {
        return reply.code(422).send({
          error: `number of submissions in a batch should be between 1 and ${CONFIG_INFO.max_submission_batch_size}`,
        });
      }
      stats.batches++;
      // Judge0 validates each item independently: valid items get a token, invalid ones get errors.
      const out = subs.map((input) => validate(input) ?? { token: create(input, base64).token });
      return reply.code(201).send(out);
    },
  );

  app.get(
    '/submissions/batch',
    { schema: { querystring: encodingQuery.extend({ tokens: z.string() }) } },
    async (req) => {
      stats.gets++;
      const base64 = req.query.base64_encoded === 'true';
      const tokens = req.query.tokens
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      return {
        submissions: tokens.map((t) => {
          const s = store.get(t);
          return s ? view(s, base64, req.query.fields) : null;
        }),
      };
    },
  );

  app.get(
    '/submissions/:token',
    { schema: { params: z.object({ token: z.string() }), querystring: encodingQuery } },
    async (req, reply) => {
      stats.gets++;
      const s = store.get(req.params.token);
      if (!s) return reply.code(404).send({ error: 'Not Found' });
      return view(s, req.query.base64_encoded === 'true', req.query.fields);
    },
  );

  // ---- test control endpoints
  app.post(
    '/__fake/faults',
    {
      schema: {
        body: z.object({
          status: z.number().int().min(400).max(599),
          count: z.number().int().min(1),
          retryAfter: z.number().optional(),
        }),
      },
    },
    async (req) => {
      fault = { ...req.body };
      return { ok: true };
    },
  );
  // clear the fault only (in-flight submissions stay): the chaos drills' "judge is back"
  app.delete('/__fake/faults', async () => {
    fault = undefined;
    return { ok: true };
  });
  app.get('/__fake/stats', async () => ({ ...stats, stored: store.size }));
  app.post('/__fake/reset', async () => {
    store.clear();
    Object.assign(stats, { created: 0, batches: 0, gets: 0, callbacks: 0 });
    fault = undefined;
    return { ok: true };
  });

  return app;
}
