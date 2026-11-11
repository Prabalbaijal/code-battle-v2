import { z } from 'zod';
import { notificationSchema } from '../http/notifications.js';
import { TOPICS, defineEvent } from './envelope.js';

/**
 * notification-service events on `notification.events`, keyed by userId. Realtime pushes them to
 * the `recipients` as `notification:new` (a changed notification is sent again with the same id).
 */
export const notificationUpsertedV1 = defineEvent(
  TOPICS.notification,
  'notification.notification.upserted.v1',
  z.object({ userId: z.uuid(), notification: notificationSchema }),
);
