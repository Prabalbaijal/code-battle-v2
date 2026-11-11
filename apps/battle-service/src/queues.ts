/** BullMQ queues owned by battle-service (plan §10.4). Names use hyphens (no colons). */
export const QUEUES = {
  /** jobId = `challenge-expire-<challengeId>`, delayed by the challenge TTL. */
  challengeExpire: 'challenge-expire',
  /** jobId = `match-timeout-<matchId>`, delayed until `ends_at`. */
  matchTimeout: 'match-timeout',
} as const;
