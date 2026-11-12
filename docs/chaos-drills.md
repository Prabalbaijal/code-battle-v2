# Chaos drills (plan §18.6, Phase 6)

Four failures injected into a running match on the full dev stack (every service, Postgres,
Redis, Redpanda, fake-judge0), two real browsers playing. Each drill is a Playwright spec in
`apps/web/e2e/chaos/` that breaks something, checks what players see, repairs it, and checks the
recovery. Nothing is mocked inside the services.

```sh
# drills 1 and 3 stop shared containers, so they only run when asked
E2E_CHAOS=1 pnpm --filter @cb/web e2e e2e/chaos/redis.spec.ts e2e/chaos/kafka.spec.ts
# drill 2 needs a command that kills and restarts the realtime node
E2E_REALTIME_RESTART="<restart command>" pnpm --filter @cb/web e2e e2e/chaos/realtime.spec.ts
# drill 4 needs battle-service with MATCH_DURATION_SECONDS=60
E2E_CHAOS=1 E2E_SHORT_MATCH=1 pnpm --filter @cb/web e2e e2e/chaos/judge.spec.ts
```

## Results (2026-11-12/13, dev laptop)

### 1. Redis stops mid-match: ✅

| Step                                             | Result                                  |
| ------------------------------------------------ | --------------------------------------- |
| Wrong answer submitted while Redis is down       | judged in 1.2 s (Postgres-driven loop)  |
| Opponent sees the activity                       | yes (Kafka → socket, no Redis involved) |
| Accepted → winner decided, both see it           | 1.6 s                                   |
| Coins                                            | +50 / −50 applied                       |
| Leaderboard during the outage                    | served from Postgres (`fallback: true`) |
| Redis back → index reflects the outage's results | 2.2 s (winner ranked above loser)       |
| Presence back (lobby online count)               | 3.2 s                                   |

### 2. A realtime node is killed and replaced mid-match: ✅

Both browsers reconnect with new tickets; the opponent's submission activity is pushed again, and
the match finishes for both (`chaos/realtime.spec.ts`, ~58 s run, Phase 3 DoD).

### 3. Redpanda (Kafka) stops mid-match: ✅

| Step                                         | Result                                                   |
| -------------------------------------------- | -------------------------------------------------------- |
| Accepted submission while the broker is down | accepted and judged in 4.1 s; the player sees "Accepted" |
| The decision (an event) during the outage    | waits in the outbox: no winner shown, nothing lost       |
| Broker back → winner on both screens         | 4.5 s                                                    |
| Coins after the broker is back               | applied (+50 visible on the end screen)                  |

### 4. The judge fails (every Judge0 call → 500): ✅ after a fix

| Step                                                  | Result                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| Submission while the judge fails                      | accepted, stays "Judging…" (no false verdict)                      |
| New challenges                                        | refused 29 s into the outage: "The judge is unavailable right now" |
| Clock runs out with a submission unjudged             | match goes to **deciding**, not to a wrong result                  |
| Judge back → pending submission judged, match decided | 9.3 s                                                              |

**Found by this drill:** admission control never refused new matches during a judge outage. The
Judge0 circuit breaker that trips lives in the judge **worker**, but battle-service asks the judge
**API** process, whose own breaker never sees a Judge0 call. Fix: every judge process records its
breaker transitions in `judge_breakers`, and capacity reports the worst live state (an `open` row
only counts until its reset time, so a dead worker can't block matches forever). Integration test
added. The refusal message also distinguishes "the judge is failing" from "today's budget is used".

## Notes

- The drills run on the dev laptop; repeat them on the VM after deployment (Phase 6 → deploy).
- A submission identical to an earlier one is answered from the verdict cache without calling
  Judge0, so drill 4 submits unique code.
