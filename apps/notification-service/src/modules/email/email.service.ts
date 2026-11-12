import { counter } from '@cb/metrics';
import type { EmailJob } from '@cb/contracts';
import type { Db } from '@cb/db';
import type { Logger } from '@cb/logger';
import { createHash } from 'node:crypto';
import { emailRepository as repo } from './email.repository.js';
import { EmailSendError, type EmailProvider } from './providers.js';
import { renderEmail } from './templates.js';

export interface EmailServiceDeps {
  db: Db;
  provider: EmailProvider;
  logger: Logger;
  dailyCap: number;
}

export type SendOutcome =
  | { status: 'sent'; messageId: string }
  /** Already sent or permanently failed earlier: nothing to do. */
  | { status: 'duplicate' }
  /** Permanent provider rejection; recorded, not retried. */
  | { status: 'failed'; error: string }
  /** Daily quota reached: the caller should delay the job until `until`. */
  | { status: 'deferred'; until: Date };

/** Thrown for errors worth retrying (BullMQ applies backoff). */
export class RetryableEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableEmailError';
  }
}

export const hashRecipient = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** Next midnight UTC plus a little jitter, so a backlog doesn't stampede the provider. */
export const nextUtcMidnight = (now = new Date()) =>
  new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) +
      Math.floor(Math.random() * 60_000),
  );

/**
 * Sends each logical email at most once (plan §8.8): `email_log` is claimed before the provider call,
 * so duplicate jobs and BullMQ retries can't double-send. A crash between the provider call and
 * `markSent` can still cause one duplicate after STALE_SENDING_SEC; that is the price of not losing mail.
 */
export class EmailService {
  constructor(private readonly d: EmailServiceDeps) {}

  /** Plan §19: emails by template and outcome (the provider's daily cap is small). */
  private static readonly sent = counter('emails_total', 'Email send attempts', ['template', 'result']);

  async send(job: EmailJob): Promise<SendOutcome> {
    if ((await repo.sentToday(this.d.db)) >= this.d.dailyCap) {
      this.d.logger.warn({ cap: this.d.dailyCap }, 'daily email cap reached; deferring');
      return { status: 'deferred', until: nextUtcMidnight() };
    }

    const claimed = await repo.claim(this.d.db, {
      dedupeKey: job.dedupeKey,
      template: job.template,
      toHash: hashRecipient(job.to),
      provider: this.d.provider.name,
    });
    if (!claimed) {
      const existing = await repo.find(this.d.db, job.dedupeKey);
      if (existing?.status === 'sending')
        throw new RetryableEmailError('another worker is sending this email');
      return { status: 'duplicate' };
    }

    const rendered = renderEmail(job.template, job.vars);
    try {
      const { messageId } = await this.d.provider.send({
        to: job.to,
        toName: job.vars.name,
        ...rendered,
        tag: job.template,
        dedupeKey: job.dedupeKey,
      });
      await repo.markSent(this.d.db, job.dedupeKey, messageId);
      this.d.logger.info({ dedupeKey: job.dedupeKey, template: job.template, messageId }, 'email sent');
      EmailService.sent.inc({ template: job.template, result: 'sent' });
      return { status: 'sent', messageId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof EmailSendError && !err.retryable) {
        await repo.markFailed(this.d.db, job.dedupeKey, msg);
        this.d.logger.error({ dedupeKey: job.dedupeKey, err: msg }, 'email rejected permanently');
        EmailService.sent.inc({ template: job.template, result: 'rejected' });
        return { status: 'failed', error: msg };
      }
      EmailService.sent.inc({ template: job.template, result: 'retry' });
      await repo.release(this.d.db, job.dedupeKey, msg);
      throw new RetryableEmailError(msg);
    }
  }

  /** Called when BullMQ gives up after all attempts. */
  async giveUp(dedupeKey: string, error: string): Promise<void> {
    await repo.markFailed(this.d.db, dedupeKey, `retries exhausted: ${error}`);
  }
}
