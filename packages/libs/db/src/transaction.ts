import type { Db, Tx } from './client.js';
import { isRetryableTxError } from './errors.js';

export interface TxOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  /** Retries on serialization failure / deadlock (plan §9.9). */
  retries?: number;
}

/**
 * Unit of work: the service layer owns the transaction boundary and passes `tx` to repositories.
 * Retries the whole callback on 40001/40P01, so the callback must have no side effects outside the tx.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const retries = opts.retries ?? (opts.isolationLevel === 'serializable' ? 3 : 0);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(
        fn,
        opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined,
      );
    } catch (err) {
      if (attempt >= retries || !isRetryableTxError(err)) throw err;
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20 * 2 ** attempt)));
    }
  }
}
