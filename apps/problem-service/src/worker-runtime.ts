import type { Infra } from './infra.js';

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * Background side. For now only the outbox relay; the `problem-calibrate` job (Phase 2, judge PR)
 * and the `battle.match.started.v1` "seen" consumer (Phase 3) join it here.
 */
export async function startWorker(infra: Infra): Promise<WorkerHandle> {
  infra.relay.start();
  return {
    async stop() {
      await infra.relay.stop();
    },
  };
}
