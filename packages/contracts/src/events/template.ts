import { z } from 'zod';
import { TOPICS, defineEvent } from './envelope.js';

/** Events of the template service (reference implementation for new services). */
export const greetingCreatedV1 = defineEvent(
  TOPICS.template,
  'template.greeting.created.v1',
  z.object({
    greetingId: z.uuid(),
    authorId: z.string(),
    message: z.string(),
    createdAt: z.iso.datetime(),
  }),
);
