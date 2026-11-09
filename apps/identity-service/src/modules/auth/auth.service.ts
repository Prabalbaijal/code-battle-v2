import { type TokenSigner, type AuthUser } from '@cb/auth';
import { identityEvents, type EmailJob, type RegisterBody } from '@cb/contracts';
import { isUniqueViolation, withTransaction, type Db, type Tx } from '@cb/db';
import { AppError, conflict, forbidden, notFound } from '@cb/errors';
import type { OutboxWriter } from '@cb/events';
import { newId } from '@cb/ids';
import type { Logger } from '@cb/logger';
import { addJobToOutbox } from '@cb/queue';
import type { Credential, TokenPurpose } from '../../db/schema.js';
import { QUEUES } from '../../queues.js';
import { credentialsRepository as creds } from './credentials.repository.js';
import { newOpaqueToken, passwords, sha256 } from './crypto.js';
import { tokensRepository as tokens } from './tokens.repository.js';

export interface AuthConfig {
  accessTtlSec: number;
  refreshTtlDays: number;
  webBaseUrl: string;
  realtimeUrl: string;
}

export interface AuthServiceDeps {
  db: Db;
  outbox: OutboxWriter;
  signer: TokenSigner;
  config: AuthConfig;
  logger: Logger;
  /** Called after a commit that wrote outbox rows (kicks relay/dispatcher for low latency). */
  afterCommit?: () => void;
}

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export interface IssuedSession {
  user: Credential;
  access: IssuedToken;
  refresh: IssuedToken;
}

export type RefreshOutcome =
  | { kind: 'ok'; session: IssuedSession }
  /** Unknown, expired, or reused (family revoked). The client must log in again. */
  | { kind: 'invalid' }
  /** Same token refreshed twice within the grace window (two tabs). Not an attack: retry. */
  | { kind: 'race' };

const VERIFY_EMAIL_TTL_MS = 24 * 3600_000;
const RESET_PASSWORD_TTL_MS = 30 * 60_000;
/** A rotated token presented again within this window is treated as a benign multi-tab race. */
export const REFRESH_RACE_GRACE_MS = 10_000;

const LINK_PATH: Record<TokenPurpose, string> = {
  verify_email: '/verify-email',
  reset_password: '/reset-password',
};

export const toAuthUser = (c: Credential): AuthUser => ({
  userId: c.userId,
  role: c.role,
  emailVerified: c.emailVerifiedAt !== null,
});

const invalidCredentials = () =>
  new AppError('INVALID_CREDENTIALS', 401, 'Invalid username/email or password');
const tokenInvalid = (status = 400) =>
  new AppError('TOKEN_INVALID', status, 'Link is invalid or has expired');

/** Use cases. Owns transaction boundaries; repositories only run SQL. Plan §8.2, §11.7, §11.8, §16. */
export class AuthService {
  constructor(private readonly d: AuthServiceDeps) {}

  async register(input: RegisterBody): Promise<Credential> {
    const passwordHash = await passwords.hash(input.password);
    const userId = newId();
    try {
      const user = await withTransaction(this.d.db, async (tx) => {
        const c = await creds.insert(tx, {
          userId,
          email: input.email,
          username: input.username,
          fullname: input.fullname,
          passwordHash,
        });
        await this.d.outbox.add(tx, identityEvents.userRegisteredV1, {
          key: userId,
          data: {
            userId,
            username: c.username,
            fullname: c.fullname,
            role: c.role,
            registeredAt: c.createdAt.toISOString(),
          },
        });
        await this.issueEmailToken(tx, c, 'verify_email');
        return c;
      });
      this.d.afterCommit?.();
      return user;
    } catch (err) {
      // The unique constraints are the source of truth (two concurrent sign-ups can't both win).
      if (isUniqueViolation(err, 'credentials_email_key'))
        throw conflict('EMAIL_TAKEN', 'Email is already registered');
      if (isUniqueViolation(err, 'credentials_username_key'))
        throw conflict('USERNAME_TAKEN', 'Username is taken');
      throw err;
    }
  }

  async login(identifier: string, password: string, meta: ClientMeta): Promise<IssuedSession> {
    const c = await creds.findByLogin(this.d.db, identifier);
    if (!c) {
      await passwords.burn(password);
      throw invalidCredentials();
    }
    if (c.lockedUntil && c.lockedUntil.getTime() > Date.now()) {
      throw new AppError('ACCOUNT_LOCKED', 423, 'Too many failed attempts. Try again later.', {
        details: { lockedUntil: c.lockedUntil.toISOString() },
      });
    }
    if (!(await passwords.verify(c.passwordHash, c.passwordAlgo, password))) {
      const lockedUntil = await creds.recordFailedLogin(this.d.db, c.userId);
      if (lockedUntil)
        this.d.logger.warn({ userId: c.userId, lockedUntil }, 'account locked after failed logins');
      throw invalidCredentials();
    }
    if (c.status !== 'active') throw forbidden('Account is disabled');

    // Migrated bcrypt hashes (and weaker Argon2 params) are upgraded on the first good login.
    const rehash = passwords.needsRehash(c.passwordHash, c.passwordAlgo)
      ? await passwords.hash(password)
      : undefined;
    const refresh = await withTransaction(this.d.db, async (tx) => {
      await creds.recordSuccessfulLogin(tx, c.userId, rehash);
      return this.createRefreshToken(tx, c.userId, newId(), meta);
    });
    return {
      user: c,
      access: await this.d.signer.signAccess(toAuthUser(c), this.d.config.accessTtlSec),
      refresh,
    };
  }

  /**
   * Rotation with reuse detection (plan §16). Every refresh replaces the token. Presenting an
   * already-rotated token revokes the whole family, because either the user or an attacker holds a
   * stolen copy. Role and verification state are re-read, so changes apply on the next refresh.
   */
  async refresh(rawToken: string, meta: ClientMeta): Promise<RefreshOutcome> {
    const hash = sha256(rawToken);
    const outcome = await withTransaction(
      this.d.db,
      async (tx): Promise<RefreshOutcome | { kind: 'rotated'; user: Credential; refresh: IssuedToken }> => {
        const row = await tokens.findRefreshForUpdate(tx, hash);
        if (!row) return { kind: 'invalid' };

        if (row.revokedAt) {
          if (row.replacedBy && Date.now() - row.revokedAt.getTime() < REFRESH_RACE_GRACE_MS)
            return { kind: 'race' };
          const n = await tokens.revokeFamily(tx, row.familyId);
          this.d.logger.warn(
            { userId: row.userId, familyId: row.familyId, revoked: n },
            'refresh token reuse detected',
          );
          return { kind: 'invalid' };
        }
        if (row.expiresAt.getTime() <= Date.now()) return { kind: 'invalid' };

        const user = await creds.findById(tx, row.userId);
        if (!user || user.status !== 'active') {
          await tokens.revokeFamily(tx, row.familyId);
          return { kind: 'invalid' };
        }
        const next = await this.createRefreshToken(tx, row.userId, row.familyId, meta);
        await tokens.markRotated(tx, row.id, next.id);
        return { kind: 'rotated', user, refresh: next };
      },
    );

    if (outcome.kind !== 'rotated') return outcome;
    const access = await this.d.signer.signAccess(toAuthUser(outcome.user), this.d.config.accessTtlSec);
    return { kind: 'ok', session: { user: outcome.user, access, refresh: outcome.refresh } };
  }

  /** Revokes the session (refresh family) the cookie belongs to. Idempotent. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const row = await tokens.findRefresh(this.d.db, sha256(rawToken));
    if (row) await tokens.revokeFamily(this.d.db, row.familyId);
  }

  /** Revokes every session. Access tokens already issued stay valid until they expire (≤ 15 min). */
  async logoutAll(userId: string): Promise<void> {
    await tokens.revokeAllForUser(this.d.db, userId);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    await withTransaction(this.d.db, async (tx) => {
      const userId = await tokens.consumeOneTime(tx, sha256(rawToken), 'verify_email');
      if (!userId) throw tokenInvalid();
      const verifiedAt = await creds.markEmailVerified(tx, userId);
      if (verifiedAt) await this.emitVerified(tx, userId, verifiedAt);
    });
    this.d.afterCommit?.();
  }

  /** Returns false when the email is already verified (nothing sent). */
  async resendVerification(userId: string): Promise<boolean> {
    const c = await creds.findById(this.d.db, userId);
    if (!c) throw notFound('User');
    if (c.emailVerifiedAt) return false;
    await withTransaction(this.d.db, (tx) => this.issueEmailToken(tx, c, 'verify_email'));
    this.d.afterCommit?.();
    return true;
  }

  /** Always succeeds from the caller's point of view, so accounts can't be enumerated (plan §11.8). */
  async forgotPassword(email: string): Promise<void> {
    const c = await creds.findByLogin(this.d.db, email);
    if (!c || c.status === 'disabled') return;
    await withTransaction(this.d.db, (tx) => this.issueEmailToken(tx, c, 'reset_password'));
    this.d.afterCommit?.();
  }

  /**
   * Consumes the token, sets the new password, unlocks the account, revokes every session and any
   * other reset link. Following an emailed link also proves the address, so it verifies the email.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const passwordHash = await passwords.hash(newPassword);
    await withTransaction(this.d.db, async (tx) => {
      const userId = await tokens.consumeOneTime(tx, sha256(rawToken), 'reset_password');
      if (!userId) throw tokenInvalid();
      await creds.setPassword(tx, userId, passwordHash);
      await tokens.invalidateOneTime(tx, userId, 'reset_password');
      await tokens.revokeAllForUser(tx, userId);
      const verifiedAt = await creds.markEmailVerified(tx, userId);
      if (verifiedAt) await this.emitVerified(tx, userId, verifiedAt);
    });
    this.d.afterCommit?.();
  }

  async me(userId: string): Promise<Credential> {
    const c = await creds.findById(this.d.db, userId);
    if (!c) throw notFound('User');
    return c;
  }

  async socketTicket(userId: string): Promise<{ ticket: string; url: string }> {
    const { ticket } = await this.d.signer.signTicket(userId, 60);
    return { ticket, url: this.d.config.realtimeUrl };
  }

  private async createRefreshToken(tx: Tx, userId: string, familyId: string, meta: ClientMeta) {
    const token = newOpaqueToken();
    const id = newId();
    const expiresAt = new Date(Date.now() + this.d.config.refreshTtlDays * 86_400_000);
    await tokens.insertRefresh(tx, {
      id,
      userId,
      familyId,
      tokenHash: sha256(token),
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip ?? null,
    });
    return { id, token, expiresAt };
  }

  /**
   * Stores the token hash and queues the email through the job outbox (same transaction).
   * The raw token only lives in the job payload: never on Kafka (retention), and the worker purges
   * dispatched job rows.
   */
  private async issueEmailToken(tx: Tx, c: Credential, purpose: TokenPurpose): Promise<void> {
    const raw = newOpaqueToken();
    const hash = sha256(raw);
    const ttl = purpose === 'verify_email' ? VERIFY_EMAIL_TTL_MS : RESET_PASSWORD_TTL_MS;
    await tokens.insertOneTime(tx, {
      tokenHash: hash,
      userId: c.userId,
      purpose,
      expiresAt: new Date(Date.now() + ttl),
    });

    const link = new URL(LINK_PATH[purpose], this.d.config.webBaseUrl);
    link.searchParams.set('token', raw);
    const tokenId = hash.toString('hex').slice(0, 24);
    const job: EmailJob = {
      template: purpose,
      to: c.email,
      vars: { name: c.fullname, link: link.toString() },
      dedupeKey: `${purpose}:${tokenId}`,
    };
    await addJobToOutbox(tx, {
      queue: QUEUES.email,
      jobId: `email-${purpose.replace('_', '-')}-${tokenId}`,
      name: purpose,
      data: job,
    });
  }

  private async emitVerified(tx: Tx, userId: string, verifiedAt: Date): Promise<void> {
    await this.d.outbox.add(tx, identityEvents.userVerifiedV1, {
      key: userId,
      data: { userId, verifiedAt: verifiedAt.toISOString() },
      recipients: [userId],
    });
  }
}
