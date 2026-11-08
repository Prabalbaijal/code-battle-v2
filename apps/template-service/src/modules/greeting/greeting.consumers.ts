import { templateEvents } from '@cb/contracts';
import { on, type EventHandler } from '@cb/events';
import type { GreetingService } from './greeting.service.js';

/** Kafka handlers. Each runs inside the consumer's inbox transaction (exactly-once effect). */
export const greetingHandlers = (service: GreetingService): EventHandler[] => [
  on(templateEvents.greetingCreatedV1, (tx, env) => service.acknowledge(tx, env.data.greetingId)),
];
