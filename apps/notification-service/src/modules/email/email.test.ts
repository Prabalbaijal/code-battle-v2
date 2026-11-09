import { describe, expect, it } from 'vitest';
import { nextUtcMidnight } from './email.service.js';
import { BrevoProvider, EmailSendError } from './providers.js';
import { renderEmail } from './templates.js';

const msg = {
  to: 'a@b.io',
  toName: 'Ann',
  subject: 'S',
  html: '<p>h</p>',
  text: 't',
  tag: 'verify_email',
  dedupeKey: 'verify_email:abc',
};

function brevo(respond: (req: { url: string; init: RequestInit }) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new BrevoProvider({
    apiKey: 'key-123',
    apiUrl: 'https://api.brevo.test/v3/',
    from: { email: 'no-reply@cb.io', name: 'Code Battle' },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond({ url, init });
    }) as typeof fetch,
  });
  return { provider, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const retryable = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof EmailSendError ? e.retryable : 'other'),
  );

describe('BrevoProvider', () => {
  it('sends the transactional API request and returns the message id', async () => {
    const { provider, calls } = brevo(() => json(201, { messageId: '<m1@brevo>' }));
    expect(await provider.send(msg)).toEqual({ messageId: '<m1@brevo>' });
    expect(calls[0]!.url).toBe('https://api.brevo.test/v3/smtp/email');
    expect((calls[0]!.init.headers as Record<string, string>)['api-key']).toBe('key-123');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      sender: { email: 'no-reply@cb.io', name: 'Code Battle' },
      to: [{ email: 'a@b.io', name: 'Ann' }],
      subject: 'S',
      htmlContent: '<p>h</p>',
      textContent: 't',
      tags: ['verify_email'],
      headers: { 'X-CB-Dedupe-Key': 'verify_email:abc' },
    });
  });

  it('400 is permanent; 401, 429, 5xx and network errors are retryable', async () => {
    expect(
      await retryable(
        brevo(() => json(400, { code: 'invalid_parameter', message: 'bad email' })).provider.send(msg),
      ),
    ).toBe(false);
    for (const status of [401, 403, 429, 500, 503]) {
      expect(await retryable(brevo(() => json(status, { message: 'x' })).provider.send(msg))).toBe(true);
    }
    expect(
      await retryable(
        brevo(() => {
          throw new TypeError('fetch failed');
        }).provider.send(msg),
      ),
    ).toBe(true);
    expect(await retryable(brevo(() => json(201, {})).provider.send(msg))).toBe(true); // no messageId
  });
});

describe('templates', () => {
  it('renders both templates with escaped name and link', () => {
    for (const t of ['verify_email', 'reset_password'] as const) {
      const r = renderEmail(t, { name: '<b>Eve</b> & co', link: 'https://cb.io/x?token=a"b' });
      expect(r.subject).toMatch(/Code Battle/);
      expect(r.html).toContain('&lt;b&gt;Eve&lt;/b&gt; &amp; co');
      expect(r.html).not.toContain('<b>Eve</b>');
      expect(r.html).toContain('href="https://cb.io/x?token=a&quot;b"');
      expect(r.text).toContain('https://cb.io/x?token=a"b');
    }
  });
});

describe('nextUtcMidnight', () => {
  it('returns the next UTC midnight within a minute of jitter', () => {
    const d = nextUtcMidnight(new Date('2026-11-10T23:59:00Z'));
    expect(d.getTime() - Date.parse('2026-11-11T00:00:00Z')).toBeGreaterThanOrEqual(0);
    expect(d.getTime() - Date.parse('2026-11-11T00:00:00Z')).toBeLessThan(60_000);
  });
});
