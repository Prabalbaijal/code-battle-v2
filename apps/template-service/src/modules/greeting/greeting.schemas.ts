import { z } from 'zod';
import type { Greeting } from '../../db/schema.js';

export const createGreetingBody = z.object({ message: z.string().trim().min(1).max(280) });
export const greetingParams = z.object({ id: z.uuid() });

export const greetingDto = z.object({
  id: z.uuid(),
  authorId: z.string(),
  message: z.string(),
  createdAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  ackCount: z.number().int(),
  jobProcessedAt: z.string().nullable(),
});
export type GreetingDto = z.infer<typeof greetingDto>;

export const toDto = (g: Greeting): GreetingDto => ({
  id: g.id,
  authorId: g.authorId,
  message: g.message,
  createdAt: g.createdAt.toISOString(),
  acknowledgedAt: g.acknowledgedAt?.toISOString() ?? null,
  ackCount: g.ackCount,
  jobProcessedAt: g.jobProcessedAt?.toISOString() ?? null,
});
