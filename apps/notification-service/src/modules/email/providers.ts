import type { Db } from '@cb/db';
import { newId } from '@cb/ids';
import { fakeInbox } from '../../db/schema.js';

export interface EmailMessage {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
  /** Provider-side tag for filtering in its dashboard. */
  tag?: string;
  dedupeKey: string;
}

/** Plan §6: swap providers without touching the service (Brevo now; Resend/SendGrid later). */
export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ messageId: string }>;
}

/** `retryable=false` means retrying can't help (bad address, rejected content): don't burn quota. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export interface BrevoOptions {
  apiKey: string;
  apiUrl: string;
  from: { email: string; name: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Brevo transactional API: POST /smtp/email → 201 { messageId }. */
export class BrevoProvider implements EmailProvider {
  readonly name = 'brevo';
  private readonly fetch: typeof fetch;

  constructor(private readonly o: BrevoOptions) {
    this.fetch = o.fetchImpl ?? fetch;
  }

  async send(msg: EmailMessage): Promise<{ messageId: string }> {
    let res: Response;
    try {
      res = await this.fetch(`${this.o.apiUrl.replace(/\/$/, '')}/smtp/email`, {
        method: 'POST',
        headers: { 'api-key': this.o.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: this.o.from,
          to: [{ email: msg.to, ...(msg.toName ? { name: msg.toName } : {}) }],
          subject: msg.subject,
          htmlContent: msg.html,
          textContent: msg.text,
          ...(msg.tag ? { tags: [msg.tag] } : {}),
          headers: { 'X-CB-Dedupe-Key': msg.dedupeKey },
        }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new EmailSendError(`brevo request failed: ${(err as Error).message}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as {
      messageId?: string;
      code?: string;
      message?: string;
    };
    if (res.ok && body.messageId) return { messageId: body.messageId };
    const detail = `brevo ${res.status}${body.code ? ` ${body.code}` : ''}: ${body.message ?? 'no message'}`;
    // 400 = invalid request/recipient → permanent. 401/403 (bad key, unverified sender), 429 and 5xx are
    // retried: an operator can fix the config and the queued mail still goes out.
    throw new EmailSendError(detail, res.status !== 400, res.status);
  }
}

/** Dev/test provider: "sends" by writing to the fake_inbox table. */
export class FakeInboxProvider implements EmailProvider {
  readonly name = 'fake';

  constructor(private readonly db: Db) {}

  async send(msg: EmailMessage): Promise<{ messageId: string }> {
    const id = newId();
    await this.db.insert(fakeInbox).values({
      id,
      to: msg.to.toLowerCase(),
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      dedupeKey: msg.dedupeKey,
    });
    return { messageId: `fake-${id}` };
  }
}
