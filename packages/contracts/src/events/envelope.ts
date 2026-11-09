import { z } from 'zod';

/** Kafka topics. Budget: ≤ 5 topics × 2 partitions (Aiven free-tier compatible). See plan §10.2. */
export const TOPICS = {
  user: 'user.events',
  problem: 'problem.events',
  battle: 'battle.events',
  judge: 'judge.events',
  rating: 'rating.events',
  /** Only used by the template service and tests. */
  template: 'template.events',
} as const;
export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

/** Envelope fields shared by every event, independent of `data`. */
export const envelopeBaseSchema = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[a-z]+(\.[a-z_]+)+\.v\d+$/, 'event type must look like domain.thing.verb.v1'),
  source: z.string().min(1),
  occurredAt: z.iso.datetime(),
  aggregateId: z.string().min(1),
  recipients: z.array(z.string()).optional(),
  traceparent: z.string().optional(),
  data: z.unknown(),
});
export type EnvelopeBase = z.infer<typeof envelopeBaseSchema>;

export type EventEnvelope<TData> = Omit<EnvelopeBase, 'data'> & { data: TData };

/** A typed event definition: the `type` string plus the zod schema of its `data`. */
export interface EventDefinition<TType extends string, TSchema extends z.ZodType> {
  readonly type: TType;
  readonly topic: Topic;
  readonly schema: TSchema;
}

export function defineEvent<const TType extends string, TSchema extends z.ZodType>(
  topic: Topic,
  type: TType,
  schema: TSchema,
): EventDefinition<TType, TSchema> {
  envelopeBaseSchema.shape.type.parse(type);
  return { type, topic, schema };
}

export type EventData<E> = E extends EventDefinition<string, infer S> ? z.infer<S> : never;
