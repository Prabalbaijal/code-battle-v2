import { z } from 'zod';

/** Who's in a challenge, enough to render a row without another lookup. */
export const playerSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullname: z.string(),
  avatarUrl: z.string().nullable(),
});
export type Player = z.infer<typeof playerSchema>;

export const challengeStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired']);
export const matchStatusSchema = z.enum(['created', 'in_progress', 'deciding', 'completed', 'aborted']);

export const createChallengeBodySchema = z.object({ toUserId: z.uuid() });
export type CreateChallengeBody = z.infer<typeof createChallengeBodySchema>;

export const challengeSchema = z.object({
  id: z.uuid(),
  from: playerSchema,
  to: playerSchema,
  status: challengeStatusSchema,
  matchId: z.uuid().nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Challenge = z.infer<typeof challengeSchema>;

/** Accepting starts the match (plan §11.2): both players then go to /battle/{matchId}. */
export const acceptChallengeResultSchema = z.object({
  matchId: z.uuid(),
  status: matchStatusSchema,
});

/** The player's open match, for the rejoin banner (plan §11.6). */
export const activeMatchSchema = z.object({
  matchId: z.uuid(),
  status: matchStatusSchema,
  opponent: playerSchema.nullable(),
  endsAt: z.iso.datetime().nullable(),
});
export type ActiveMatch = z.infer<typeof activeMatchSchema>;

/** Internal: judge intake asks whether a user may submit in a match (plan §11.3). */
export const participationSchema = z.object({
  matchId: z.uuid(),
  userId: z.uuid(),
  participant: z.boolean(),
  status: matchStatusSchema,
  problemId: z.uuid().nullable(),
  endsAt: z.iso.datetime().nullable(),
});
export type Participation = z.infer<typeof participationSchema>;

/** Snapshot for /battle/{id} (plan §11.6); live events follow over the socket. */
export const matchStateSchema = z.object({
  matchId: z.uuid(),
  status: matchStatusSchema,
  problemId: z.uuid().nullable(),
  problemSlug: z.string().nullable(),
  players: z.array(playerSchema),
  startedAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  decideDeadline: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  winnerId: z.uuid().nullable(),
  endReason: z.enum(['solved', 'forfeit', 'timeout', 'aborted', 'legacy']).nullable(),
  /** For a countdown that doesn't trust the client clock. */
  serverNow: z.iso.datetime(),
  mySubmissions: z.array(
    z.object({ submissionId: z.uuid(), submittedAt: z.iso.datetime(), verdict: z.string().nullable() }),
  ),
  /** The opponent's code and verdicts stay private; only how busy they are. */
  opponentProgress: z.object({ submitted: z.number(), judged: z.number() }),
});
export type MatchState = z.infer<typeof matchStateSchema>;

export const matchHistoryItemSchema = z.object({
  matchId: z.uuid(),
  status: matchStatusSchema,
  opponent: playerSchema.nullable(),
  result: z.enum(['win', 'loss', 'draw']).nullable(),
  endReason: z.enum(['solved', 'forfeit', 'timeout', 'aborted', 'legacy']).nullable(),
  problemSlug: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
});
export type MatchHistoryItem = z.infer<typeof matchHistoryItemSchema>;

/** Plan §13.5: one tab plays a match; others show "Use here". Renew every 10 s (lease 30 s). */
export const tabLeaseBodySchema = z.object({
  tabId: z.string().min(8).max(64),
  /** "Use here": take the lease from another tab. */
  takeover: z.boolean().default(false),
});
export const tabLeaseResultSchema = z.object({
  granted: z.boolean(),
  /** The tab holding the lease now. */
  holder: z.string().nullable(),
});
export type TabLeaseResult = z.infer<typeof tabLeaseResultSchema>;
