import type { LoginBody, Me, RegisterBody, Session, SocketTicket } from '@cb/contracts';
import type { Credential } from '../../db/schema.js';
import type { AuthService, ClientMeta, IssuedSession, RefreshOutcome } from './auth.service.js';

export const toMe = (c: Credential): Me => ({
  id: c.userId,
  username: c.username,
  fullname: c.fullname,
  email: c.email,
  role: c.role,
  emailVerified: c.emailVerifiedAt !== null,
  createdAt: c.createdAt.toISOString(),
});

export const toSession = (s: IssuedSession): Session => ({
  user: toMe(s.user),
  accessTokenExpiresAt: s.access.expiresAt.toISOString(),
});

/** Maps HTTP input to use cases and results to DTOs. Cookies are handled by the routes. */
export class AuthController {
  constructor(private readonly service: AuthService) {}

  async register(body: RegisterBody): Promise<Me> {
    return toMe(await this.service.register(body));
  }

  login(body: LoginBody, meta: ClientMeta): Promise<IssuedSession> {
    return this.service.login(body.identifier, body.password, meta);
  }

  refresh(rawToken: string, meta: ClientMeta): Promise<RefreshOutcome> {
    return this.service.refresh(rawToken, meta);
  }

  logout(rawToken: string | undefined): Promise<void> {
    return this.service.logout(rawToken);
  }

  logoutAll(userId: string): Promise<void> {
    return this.service.logoutAll(userId);
  }

  async verifyEmail(token: string): Promise<{ verified: true }> {
    await this.service.verifyEmail(token);
    return { verified: true };
  }

  async resendVerification(userId: string): Promise<{ sent: boolean }> {
    return { sent: await this.service.resendVerification(userId) };
  }

  async forgotPassword(email: string): Promise<{ ok: true }> {
    await this.service.forgotPassword(email);
    return { ok: true };
  }

  async resetPassword(token: string, password: string): Promise<{ ok: true }> {
    await this.service.resetPassword(token, password);
    return { ok: true };
  }

  async me(userId: string): Promise<Me> {
    return toMe(await this.service.me(userId));
  }

  socketTicket(userId: string): Promise<SocketTicket> {
    return this.service.socketTicket(userId);
  }
}
