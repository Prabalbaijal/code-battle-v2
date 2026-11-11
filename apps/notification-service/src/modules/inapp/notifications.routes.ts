import { authUser, type AuthHooks } from '@cb/auth';
import {
  cursorQuerySchema,
  notificationPageSchema,
  notificationSchema,
  unreadCountSchema,
} from '@cb/contracts';
import type { HttpServer } from '@cb/http-server';
import { z } from 'zod';
import type { NotificationService } from './notifications.service.js';

/** Plan §8.8. All of these are the signed-in user's own notifications. */
export function registerNotificationRoutes(
  app: HttpServer,
  d: { notifications: NotificationService; auth: AuthHooks },
): void {
  const signedIn = [d.auth.authenticate];
  const BASE = '/api/v1/notifications';

  app.get(
    BASE,
    {
      schema: { querystring: cursorQuerySchema, response: { 200: notificationPageSchema } },
      preHandler: signedIn,
    },
    async (req) => d.notifications.list(authUser(req).userId, req.query.cursor, req.query.limit),
  );
  app.get(
    `${BASE}/unread-count`,
    { schema: { response: { 200: unreadCountSchema } }, preHandler: signedIn },
    async (req) => ({ count: await d.notifications.unreadCount(authUser(req).userId) }),
  );
  // marking read is naturally idempotent, so no idempotency key is needed
  app.post(
    `${BASE}/read-all`,
    { schema: { response: { 200: z.object({ updated: z.number() }) } }, preHandler: signedIn },
    async (req) => ({ updated: await d.notifications.readAll(authUser(req).userId) }),
  );
  app.post(
    `${BASE}/:id/read`,
    {
      schema: { params: z.object({ id: z.uuid() }), response: { 200: notificationSchema } },
      preHandler: signedIn,
    },
    async (req) => d.notifications.read(authUser(req).userId, req.params.id),
  );
}
