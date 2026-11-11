/** BullMQ queues owned by judge-service (plan §10.4). Names use hyphens (no colons). */
export const QUEUES = {
  /** Start judging a submission (stage 1). jobId = `submit-<submissionId>`. */
  submit: 'judge-submit',
  /** Fetch pending results when no callback arrived. jobId = `poll-<submissionId>-<n>`. */
  poll: 'judge-poll',
  /** Weekly benchmark (plan §14.8), plus manual runs from the admin page. */
  drift: 'judge-drift',
} as const;

/** Poll schedule: quick in poll mode, a slow fallback in callback mode; gives up after ~5 min. */
export const POLL_DELAYS_MS = {
  poll: [1_000, 1_500, 2_000, 3_000, 5_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000],
  callback: [15_000, 30_000, 60_000, 60_000, 60_000, 60_000],
} as const;
