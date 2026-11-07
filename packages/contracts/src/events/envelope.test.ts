import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOPICS, defineEvent, envelopeBaseSchema } from './envelope.js';

describe('event envelope', () => {
  it('rejects event types that do not follow domain.thing.verb.vN', () => {
    expect(() => defineEvent(TOPICS.battle, 'MatchCompleted', z.object({}))).toThrow();
    expect(() => defineEvent(TOPICS.battle, 'battle.match.completed', z.object({}))).toThrow();
    expect(defineEvent(TOPICS.battle, 'battle.match.completed.v1', z.object({})).type).toBe(
      'battle.match.completed.v1',
    );
  });

  it('validates the base envelope', () => {
    const ok = envelopeBaseSchema.safeParse({
      id: '0190f5b2-6c1e-7cc2-9a59-3b0f6f3c2a11',
      type: 'battle.match.completed.v1',
      source: 'battle-service',
      occurredAt: new Date().toISOString(),
      aggregateId: 'm1',
      data: { anything: true },
    });
    expect(ok.success).toBe(true);
    expect(envelopeBaseSchema.safeParse({ id: 'nope' }).success).toBe(false);
  });
});
