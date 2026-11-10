/**
 * Bootstrap roles from the command line (the first admin can't be made through the API).
 *   pnpm --filter @cb/identity-service set-role <username> <user|problem_setter|admin>
 * Emits identity.user.role_changed.v1 through the outbox; the new role applies on the user's next
 * token refresh (≤ 15 min) or login.
 */
import { identityEvents, ROLES, type Role } from '@cb/contracts';
import { createDb, withTransaction } from '@cb/db';
import { createOutboxWriter } from '@cb/events';
import { eq, sql } from 'drizzle-orm';
import { credentials } from '../db/schema.js';

/** Actor id recorded for changes made outside the API. */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export async function setRole(
  databaseUrl: string,
  username: string,
  role: Role,
): Promise<{ changed: boolean }> {
  const h = createDb({ connectionString: databaseUrl, max: 1 });
  const outbox = createOutboxWriter('identity-service');
  try {
    return await withTransaction(h.db, async (tx) => {
      const [c] = await tx.select().from(credentials).where(eq(credentials.username, username)).for('update');
      if (!c) throw new Error(`no user named "${username}"`);
      if (c.role === role) return { changed: false };
      await tx
        .update(credentials)
        .set({ role, updatedAt: sql`now()` })
        .where(eq(credentials.userId, c.userId));
      await outbox.add(tx, identityEvents.userRoleChangedV1, {
        key: c.userId,
        data: { userId: c.userId, role, previousRole: c.role, actorId: SYSTEM_ACTOR },
        recipients: [c.userId],
      });
      return { changed: true };
    });
  } finally {
    await h.close();
  }
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/set-role.js');
if (isMain) {
  const [username, role] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url || !username || !ROLES.includes(role as Role)) {
    process.stderr.write(`usage: set-role <username> <${ROLES.join('|')}>  (needs DATABASE_URL)\n`);
    process.exit(1);
  }
  const r = await setRole(url, username, role as Role);
  process.stdout.write(r.changed ? `${username} is now ${role}\n` : `${username} already has role ${role}\n`);
}
