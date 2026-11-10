import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemServiceSource } from './problem-source.js';

const ID = '01a1c75b-de0b-73cf-9409-a5cd58eeadf0';
let status: 'draft' | 'published' = 'draft';
let hits = 0;
let server: Server;
let source: ProblemServiceSource;

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        problemId: ID,
        version: status === 'draft' ? 4 : 5,
        status,
        checker: { type: 'tokens', eps: null },
        memoryLimitKb: 196_608,
        outputLimitKb: 1024,
        files: [],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  source = new ProblemServiceSource({
    baseUrl: `http://127.0.0.1:${port}`,
    secret: 's'.repeat(40),
    service: 'judge-service',
    specTtlMs: 60_000,
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('ProblemServiceSource.spec', () => {
  it('never caches drafts, so a publish is visible to players at once; published specs are cached', async () => {
    expect((await source.spec(ID))?.status).toBe('draft'); // e.g. calibration reads the draft
    status = 'published'; // the setter publishes
    expect((await source.spec(ID))?.status).toBe('published');
    expect(hits).toBe(2);
    await source.spec(ID);
    expect(hits).toBe(2); // served from cache
  });
});
