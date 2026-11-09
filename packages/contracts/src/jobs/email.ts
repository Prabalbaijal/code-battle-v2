import { z } from 'zod';

/** BullMQ queue consumed by notification-service (plan §10.4). Producers write via their job outbox. */
export const EMAIL_QUEUE = 'email-send';

export const EMAIL_TEMPLATES = ['verify_email', 'reset_password'] as const;
export const emailTemplateSchema = z.enum(EMAIL_TEMPLATES);
export type EmailTemplate = z.infer<typeof emailTemplateSchema>;

export const emailJobSchema = z.object({
  template: emailTemplateSchema,
  to: z.email(),
  /** Template variables. Links carry one-time tokens, so jobs are removed once sent. */
  vars: z.object({ name: z.string(), link: z.url() }),
  /** notification-service sends each dedupeKey at most once (`email_log`). */
  dedupeKey: z.string().min(1).max(200),
});
export type EmailJob = z.infer<typeof emailJobSchema>;
