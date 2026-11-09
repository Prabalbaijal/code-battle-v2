import type { EmailTemplate } from '@cb/contracts';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Vars {
  name: string;
  link: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const COPY: Record<
  EmailTemplate,
  { subject: string; intro: string; button: string; expiry: string; outro: string }
> = {
  verify_email: {
    subject: 'Verify your Code Battle email',
    intro: 'Welcome to Code Battle! Confirm your email address to start battling.',
    button: 'Verify email',
    expiry: 'This link expires in 24 hours.',
    outro: "If you didn't create an account, you can ignore this email.",
  },
  reset_password: {
    subject: 'Reset your Code Battle password',
    intro: 'We received a request to reset your password.',
    button: 'Reset password',
    expiry: 'This link expires in 30 minutes and works once. Resetting signs you out everywhere.',
    outro: "If you didn't ask for this, ignore this email; your password stays the same.",
  },
};

/** Plain, inline-styled HTML (email clients ignore <style>), plus a text part. */
export function renderEmail(template: EmailTemplate, vars: Vars): RenderedEmail {
  const c = COPY[template];
  const name = escapeHtml(vars.name);
  const link = escapeHtml(vars.link);
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
<tr><td>
<h1 style="margin:0 0 16px;font-size:20px">Hi ${name},</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escapeHtml(c.intro)}</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold">${escapeHtml(c.button)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#52525b">${escapeHtml(c.expiry)}</p>
<p style="margin:0 0 8px;font-size:13px;color:#52525b">Or paste this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
<p style="margin:16px 0 0;font-size:13px;color:#71717a">${escapeHtml(c.outro)}</p>
</td></tr></table></body></html>`;
  const text = `Hi ${vars.name},\n\n${c.intro}\n\n${c.button}: ${vars.link}\n\n${c.expiry}\n${c.outro}\n`;
  return { subject: c.subject, html, text };
}
