/**
 * Challenge and match rules (plan §11). Pure: battle-service owns the transactions, this decides.
 */

export const CHALLENGE_STATUSES = ['pending', 'accepted', 'rejected', 'cancelled', 'expired'] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const MATCH_STATUSES = ['created', 'in_progress', 'deciding', 'completed', 'aborted'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const END_REASONS = ['solved', 'forfeit', 'timeout', 'aborted', 'legacy'] as const;
export type EndReason = (typeof END_REASONS)[number];

/** A challenge waits this long for an answer (v1: 30 s). */
export const CHALLENGE_TTL_MS = 30_000;
/** Match length, measured on the server only (v1: 30 min). */
export const MATCH_DURATION_MS = 30 * 60_000;
/** How long `deciding` may wait for missing verdicts before resolving with what it has. */
export const DECIDE_CAP_MS = 10 * 60_000;
/** A match still `created` after this is a crashed start: the reconciler aborts it. */
export const CREATED_STUCK_MS = 30_000;
/** The reconciler handles a timeout this long after `ends_at` if the timeout job was lost. */
export const TIMEOUT_GRACE_MS = 5_000;

/** Challenges: pending → accepted | rejected | cancelled | expired, all terminal. */
export const canTransitionChallenge = (from: ChallengeStatus, to: ChallengeStatus): boolean =>
  from === 'pending' && to !== 'pending';

const MATCH_NEXT: Record<MatchStatus, readonly MatchStatus[]> = {
  created: ['in_progress', 'aborted'],
  in_progress: ['deciding', 'completed', 'aborted'],
  deciding: ['completed', 'aborted'],
  completed: [],
  aborted: [],
};
export const canTransitionMatch = (from: MatchStatus, to: MatchStatus): boolean =>
  MATCH_NEXT[from].includes(to);

export const isOpen = (s: MatchStatus): boolean => s === 'in_progress' || s === 'deciding';

/** One Submit in a match, as the battle read model knows it. `verdict: null` = still judging. */
export interface MatchSubmission {
  submissionId: string;
  userId: string;
  submittedAt: Date;
  verdict: string | null;
}

export type Decision =
  /** Nothing to do: the match keeps running. */
  | { kind: 'continue' }
  /** An answer depends on verdicts that haven't arrived: wait (status `deciding`). */
  | { kind: 'deciding' }
  /** The earliest-submitted AC wins. */
  | { kind: 'winner'; userId: string; submissionId: string }
  /** Time is up, nobody solved it, every verdict is in: no winner. */
  | { kind: 'timeout' }
  /** The deciding cap passed with no AC and verdicts still missing: no result, no coin change. */
  | { kind: 'abort' };

const before = (a: MatchSubmission, b: MatchSubmission) =>
  a.submittedAt.getTime() < b.submittedAt.getTime() ||
  (a.submittedAt.getTime() === b.submittedAt.getTime() && a.submissionId < b.submissionId);

/**
 * What the match should do now (plan §11.3–11.4). Fairness: the earliest *submitted* AC wins, not
 * the earliest judged, so an AC waits while an opponent's earlier submission is still being judged.
 * Submissions at or after `endsAt` never count (intake refuses them; this is the second guard).
 *
 * @param capReached the match is `deciding` and its `decide_deadline` has passed
 */
export function decide(
  subs: MatchSubmission[],
  ctx: { now: Date; endsAt: Date; capReached: boolean },
): Decision {
  const valid = subs
    .filter((s) => s.submittedAt.getTime() < ctx.endsAt.getTime())
    .sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  const firstAc = valid.find((s) => s.verdict === 'AC');

  if (firstAc) {
    // Only an opponent's earlier pending submission can change the winner.
    const blocking = valid.some(
      (s) => s.verdict === null && s.userId !== firstAc.userId && before(s, firstAc),
    );
    if (blocking && !ctx.capReached) return { kind: 'deciding' };
    return { kind: 'winner', userId: firstAc.userId, submissionId: firstAc.submissionId };
  }

  if (ctx.now.getTime() < ctx.endsAt.getTime()) return { kind: 'continue' };
  if (valid.some((s) => s.verdict === null)) return ctx.capReached ? { kind: 'abort' } : { kind: 'deciding' };
  return { kind: 'timeout' };
}

export type ParticipantResult = 'win' | 'loss' | 'draw';

/** Per-player result for a finished match. A timeout has no winner: both get `draw`. */
export function results(
  userIds: string[],
  outcome: { winnerId: string | null; endReason: EndReason },
): Record<string, ParticipantResult | null> {
  const out: Record<string, ParticipantResult | null> = {};
  for (const id of userIds) {
    if (outcome.endReason === 'aborted') out[id] = null;
    else if (outcome.winnerId === null) out[id] = 'draw';
    else out[id] = id === outcome.winnerId ? 'win' : 'loss';
  }
  return out;
}
