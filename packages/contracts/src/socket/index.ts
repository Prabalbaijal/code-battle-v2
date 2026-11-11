/**
 * Typed Socket.IO event maps shared by realtime nodes and the web client (plan §13.4).
 * Client → server is only `presence:ping`; everything else the client does is REST.
 */
export interface ServerEnvelope<T> {
  /** The Kafka event id (dedupe on the client). */
  eventId: string;
  type: string;
  ts: string;
  /** Match-scoped events: `matches.version`; a gap means "refetch the state". */
  seq?: number;
  data: T;
}

export const PRESENCE_STATUSES = ['offline', 'online', 'in_match'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export interface PresenceFriend {
  userId: string;
  username: string;
  fullname: string;
  avatarUrl: string | null;
  status: PresenceStatus;
}

export interface ServerEvents {
  /** On connect: the user's friends and their status. */
  'presence:snapshot': { friends: PresenceFriend[] };
  /** A friend came online, went offline, or started/finished a match. */
  'presence:update': { userId: string; status: PresenceStatus };
  'challenge:received': {
    challengeId: string;
    from: { userId: string; username: string; fullname: string; avatarUrl: string | null };
    expiresAt: string;
  };
  'challenge:updated': {
    challengeId: string;
    status: 'accepted' | 'rejected' | 'cancelled' | 'expired';
    matchId?: string;
  };
  'match:started': {
    matchId: string;
    problemId: string;
    startedAt: string;
    endsAt: string;
    serverNow: string;
  };
  'match:deciding': { matchId: string; decideDeadline: string };
  'match:ended': {
    matchId: string;
    winnerId: string | null;
    endReason: 'solved' | 'forfeit' | 'timeout';
    results: Record<string, 'win' | 'loss' | 'draw'>;
  };
  'match:aborted': { matchId: string; reason: string };
  /** Submitter only. */
  'submission:progress': { submissionId: string; matchId: string | null; stage: number; status: string };
  /** Submitter only. */
  'submission:verdict': {
    submissionId: string;
    matchId: string | null;
    mode: 'submit' | 'run';
    verdict: string;
    failedFile: number | null;
    failedCase: number | null;
    maxCpuMs: number | null;
    maxMemKb: number | null;
  };
  /** The opponent's activity: no code, no details. */
  'match:opponent-activity': { matchId: string; type: 'submitted' | 'judged'; verdict?: string };
  /** The player's coins/level changed (after a match). */
  'stats:updated': { coins: number; level: number; delta: number; matchId: string | null };
  /** The node is shutting down: reconnect (with a new ticket). */
  'server:reconnect': Record<string, never>;
}
export type ServerEventName = keyof ServerEvents;

export type ServerToClientEvents = {
  [K in ServerEventName]: (msg: ServerEnvelope<ServerEvents[K]>) => void;
};

export interface ClientToServerEvents {
  'presence:ping': () => void;
}
