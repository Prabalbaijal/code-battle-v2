/**
 * Judge0 quota (plan §14.6). The unit is one Judge0 *request* that creates submissions: hosted
 * Judge0 (RapidAPI) counts a batch of N files as one call, so that is what the budget counts.
 * Polling (GET) is free.
 */

/** Requests needed to send `runs` file runs in batches of at most `maxBatch`. */
export const requestsFor = (runs: number, maxBatch: number): number =>
  runs <= 0 ? 0 : Math.ceil(runs / Math.max(1, maxBatch));

/**
 * The degradation ladder, as the day's remaining budget shrinks (plan §14.6.6):
 * - below 30%: no custom-input Runs;
 * - below 15%: Runs are throttled to one per user per minute;
 * - below 5%: no new matches (battle-service reads this from /internal/capacity) and a banner.
 */
export const DEGRADATION_LEVELS = ['normal', 'no_custom_input', 'runs_throttled', 'no_new_matches'] as const;
export type DegradationLevel = (typeof DEGRADATION_LEVELS)[number];

export function degradationLevel(remaining: number, limit: number): DegradationLevel {
  if (limit <= 0) return 'no_new_matches';
  const left = remaining / limit;
  if (left < 0.05) return 'no_new_matches';
  if (left < 0.15) return 'runs_throttled';
  if (left < 0.3) return 'no_custom_input';
  return 'normal';
}

/** Is `level` at least as severe as `atLeast`? */
export const isAtLeast = (level: DegradationLevel, atLeast: DegradationLevel): boolean =>
  DEGRADATION_LEVELS.indexOf(level) >= DEGRADATION_LEVELS.indexOf(atLeast);
