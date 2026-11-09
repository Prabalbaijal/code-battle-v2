import { z } from 'zod';
import { roleSchema } from '../http/auth.js';
import { TOPICS, defineEvent } from './envelope.js';

/**
 * identity-service events on `user.events`, keyed by userId (plan §10.2).
 * No email address or token is ever put on Kafka (retention).
 */
export const userRegisteredV1 = defineEvent(
  TOPICS.user,
  'identity.user.registered.v1',
  z.object({
    userId: z.uuid(),
    username: z.string(),
    fullname: z.string(),
    role: roleSchema,
    registeredAt: z.iso.datetime(),
  }),
);

export const userVerifiedV1 = defineEvent(
  TOPICS.user,
  'identity.user.verified.v1',
  z.object({ userId: z.uuid(), verifiedAt: z.iso.datetime() }),
);

export const userRoleChangedV1 = defineEvent(
  TOPICS.user,
  'identity.user.role_changed.v1',
  z.object({ userId: z.uuid(), role: roleSchema, previousRole: roleSchema, actorId: z.uuid() }),
);
