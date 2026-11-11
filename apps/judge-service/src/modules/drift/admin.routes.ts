import { adminJudgeViewSchema } from '@cb/contracts';
import type { AuthHooks } from '@cb/auth';
import type { HttpServer } from '@cb/http-server';
import type { Queue } from 'bullmq';
import { z } from 'zod';
import type { SubmissionService } from '../submissions/submissions.service.js';
import type { DriftService } from './drift.service.js';

export interface AdminRouteDeps {
  submissions: SubmissionService;
  drift: DriftService;
  driftQueue: Queue;
  auth: AuthHooks;
}

/** Admin view of the judge: today's quota, the degradation level and drift (plan §14.6, §14.8). */
export function registerAdminRoutes(app: HttpServer, d: AdminRouteDeps): void {
  const admin = [d.auth.authenticate, d.auth.requireRole('admin')];

  app.get(
    '/api/v1/admin/judge',
    {
      schema: { response: { 200: adminJudgeViewSchema } },
      preHandler: admin,
    },
    async () => ({ capacity: await d.submissions.capacity(), drift: await d.drift.status() }),
  );

  // Runs in the worker (it polls Judge0 for up to a minute); the page refreshes to see the result.
  app.post(
    '/api/v1/admin/judge/drift-check',
    { schema: { response: { 202: z.object({ queued: z.literal(true) }) } }, preHandler: admin },
    async (_req, reply) => {
      await d.driftQueue.add('check', {}, { jobId: `drift-manual-${Date.now()}` });
      return reply.code(202).send({ queued: true as const });
    },
  );
}
