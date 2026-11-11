import {
  battleEvents,
  judgeEvents,
  userEvents,
  type EnvelopeBase,
  type ServerEnvelope,
  type ServerEventName,
  type ServerEvents,
} from '@cb/contracts';

/**
 * Kafka event → what to send over sockets (plan §13.2, §13.4). Pure, so it is unit-tested; the
 * consumer resolves `opponentsOf` (match participants) and applies the side effects.
 */
export type Target = { userIds: string[] } | { opponentsOf: { matchId: string; userId: string } };

export interface Delivery<K extends ServerEventName = ServerEventName> {
  to: Target;
  event: K;
  message: ServerEnvelope<ServerEvents[K]>;
}

/** Presence/bookkeeping consequences of an event, applied by every node (idempotent). */
export type SideEffect =
  | { kind: 'match-started'; matchId: string; userIds: string[] }
  | { kind: 'match-over'; matchId: string; userIds: string[] }
  | { kind: 'friendship'; userLow: string; userHigh: string; accepted: boolean };

const wrap = <K extends ServerEventName>(
  env: EnvelopeBase,
  data: ServerEvents[K],
  seq?: number,
): ServerEnvelope<ServerEvents[K]> => ({
  eventId: env.id,
  type: env.type,
  ts: env.occurredAt,
  ...(seq !== undefined ? { seq } : {}),
  data,
});

const deliver = <K extends ServerEventName>(
  to: Target,
  event: K,
  env: EnvelopeBase,
  data: ServerEvents[K],
  seq?: number,
): Delivery => ({ to, event, message: wrap(env, data, seq) }) as Delivery;

export function route(
  env: EnvelopeBase,
  now = new Date(),
): { deliveries: Delivery[]; effects: SideEffect[] } {
  const recipients = { userIds: env.recipients ?? [] };
  const parse = <S extends { schema: { parse: (v: unknown) => unknown } }>(def: S) =>
    def.schema.parse(env.data) as ReturnType<S['schema']['parse']>;

  switch (env.type) {
    case battleEvents.challengeCreatedV1.type: {
      const d = parse(battleEvents.challengeCreatedV1);
      return {
        deliveries: [
          deliver(recipients, 'challenge:received', env, {
            challengeId: d.challengeId,
            from: { userId: d.fromUserId, ...d.from },
            expiresAt: d.expiresAt,
          }),
        ],
        effects: [],
      };
    }
    case battleEvents.challengeAcceptedV1.type: {
      const d = parse(battleEvents.challengeAcceptedV1);
      return {
        deliveries: [
          deliver(recipients, 'challenge:updated', env, {
            challengeId: d.challengeId,
            status: 'accepted',
            matchId: d.matchId,
          }),
        ],
        effects: [],
      };
    }
    case battleEvents.challengeRejectedV1.type:
    case battleEvents.challengeCancelledV1.type:
    case battleEvents.challengeExpiredV1.type: {
      const d = parse(battleEvents.challengeRejectedV1);
      const status = env.type.split('.')[2] as 'rejected' | 'cancelled' | 'expired';
      return {
        deliveries: [deliver(recipients, 'challenge:updated', env, { challengeId: d.challengeId, status })],
        effects: [],
      };
    }
    case battleEvents.matchStartedV1.type: {
      const d = parse(battleEvents.matchStartedV1);
      return {
        deliveries: [
          deliver(
            recipients,
            'match:started',
            env,
            {
              matchId: d.matchId,
              problemId: d.problemId,
              startedAt: d.startedAt,
              endsAt: d.endsAt,
              serverNow: now.toISOString(),
            },
            d.version,
          ),
        ],
        effects: [{ kind: 'match-started', matchId: d.matchId, userIds: d.userIds }],
      };
    }
    case battleEvents.matchDecidingV1.type: {
      const d = parse(battleEvents.matchDecidingV1);
      return {
        deliveries: [
          deliver(
            recipients,
            'match:deciding',
            env,
            { matchId: d.matchId, decideDeadline: d.decideDeadline },
            d.version,
          ),
        ],
        effects: [],
      };
    }
    case battleEvents.matchCompletedV1.type: {
      const d = parse(battleEvents.matchCompletedV1);
      return {
        deliveries: [
          deliver(
            recipients,
            'match:ended',
            env,
            { matchId: d.matchId, winnerId: d.winnerId, endReason: d.endReason, results: d.results },
            d.version,
          ),
        ],
        effects: [{ kind: 'match-over', matchId: d.matchId, userIds: d.userIds }],
      };
    }
    case battleEvents.matchAbortedV1.type: {
      const d = parse(battleEvents.matchAbortedV1);
      return {
        deliveries: [
          deliver(recipients, 'match:aborted', env, { matchId: d.matchId, reason: d.reason }, d.version),
        ],
        effects: [{ kind: 'match-over', matchId: d.matchId, userIds: d.userIds }],
      };
    }

    // Judge events have no recipients: the submitter gets the details, the opponent only activity.
    case judgeEvents.submissionCreatedV1.type: {
      const d = parse(judgeEvents.submissionCreatedV1);
      if (!d.matchId || d.mode !== 'submit') return { deliveries: [], effects: [] };
      return {
        deliveries: [
          deliver({ opponentsOf: { matchId: d.matchId, userId: d.userId } }, 'match:opponent-activity', env, {
            matchId: d.matchId,
            type: 'submitted',
          }),
        ],
        effects: [],
      };
    }
    case judgeEvents.submissionProgressV1.type: {
      const d = parse(judgeEvents.submissionProgressV1);
      return {
        deliveries: [
          deliver({ userIds: [d.userId] }, 'submission:progress', env, {
            submissionId: d.submissionId,
            matchId: d.matchId,
            stage: d.stage,
            status: d.status,
          }),
        ],
        effects: [],
      };
    }
    case judgeEvents.submissionJudgedV1.type: {
      const d = parse(judgeEvents.submissionJudgedV1);
      const deliveries: Delivery[] = [
        deliver({ userIds: [d.userId] }, 'submission:verdict', env, {
          submissionId: d.submissionId,
          matchId: d.matchId,
          mode: d.mode,
          verdict: d.verdict,
          failedFile: d.failedFile,
          failedCase: d.failedCase,
          maxCpuMs: d.maxCpuMs,
          maxMemKb: d.maxMemKb,
        }),
      ];
      if (d.matchId && d.mode === 'submit') {
        deliveries.push(
          deliver({ opponentsOf: { matchId: d.matchId, userId: d.userId } }, 'match:opponent-activity', env, {
            matchId: d.matchId,
            type: 'judged',
            verdict: d.verdict,
          }),
        );
      }
      return { deliveries, effects: [] };
    }

    case userEvents.friendshipChangedV1.type: {
      const d = parse(userEvents.friendshipChangedV1);
      return {
        deliveries: [],
        effects: [
          { kind: 'friendship', userLow: d.userLow, userHigh: d.userHigh, accepted: d.change === 'accepted' },
        ],
      };
    }
    default:
      return { deliveries: [], effects: [] };
  }
}
