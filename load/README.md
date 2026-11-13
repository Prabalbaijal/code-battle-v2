# Load tests (k6, plan §20)

One k6 script, `arena.js`, runs three things at once against the full stack, with fake-judge0 as
the judge:

| Scenario  | What each virtual user does                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `online`  | logs in, gets a socket ticket, opens a real Socket.IO connection (engine.io v4 over WebSocket), answers heartbeats, sends `presence:ping`, holds it                                           |
| `browse`  | a signed-in player clicking around: leaderboard, my rank, profile (BFF), lobby list and count, unread count, active match, once a second                                                      |
| `matches` | pairs of players: A challenges B (B must be online), B accepts (the whole start saga), A submits unique code (no verdict cache), waits for the verdict; B forfeits if the match isn't decided |

Every request goes browser-style through the web app's `/api` proxy → gateway → service, and every
virtual user has its own client address (`X-Forwarded-For`), so per-IP rate limits apply per player.
Players are registered and verified through the API in `setup()` (dev fake inbox).

```sh
# the dev stack must be running (fake-judge0, EMAIL_PROVIDER=fake)
docker run --rm --add-host=host.docker.internal:host-gateway -v "$PWD/load:/scripts" \
  grafana/k6:2.3.0 run /scripts/arena.js
# scale: -e PAIRS=20 -e SOCKETS=200 -e BROWSERS=40 -e ROUNDS=3 -e DURATION=2m
```

Thresholds (the run fails if missed) are the plan's SLOs: API p95 < 200 ms, match start p95 <
1.5 s, submit → verdict p95 < 6 s, ≥ 99 % sockets connected, ≥ 99 % checks passing. A summary prints
at the end and the full k6 JSON lands in `load/results/` (gitignored).

Each pair can play as many rounds as there are published problems neither player has seen.

## Results (2026-11-13, dev laptop: 12 logical CPUs, everything on one machine, k6 included)

Run: 40 browsing players, 200 sockets held 4 min, 20 pairs × 3 matches, fake-judge0.

| Measure                            | Client (k6)                     | Server (Prometheus)     | SLO      |
| ---------------------------------- | ------------------------------- | ----------------------- | -------- |
| API reads p95 (browse)             | 602 ms                          | ≤ 121 ms on every route | < 200 ms |
| Match start p95 (accept → started) | **1 259 ms** ✓                  | —                       | < 1.5 s  |
| Submit → verdict p95               | 6.75 s (1 s polling)            | **5.4 s** ✓             | < 6 s    |
| Sockets connected / connect p95    | **99.5 %** ✓ / 622 ms           | —                       | ≥ 99 %   |
| Matches                            | **60 / 60 completed**, 0 failed | —                       |          |
| Requests                           | 15 184 in ~4 min                | —                       |          |

**Reading it:** every service answers well inside its SLO (server-side). What the client sees on
top comes from the machine: during a browse burst the laptop sat at **81 % CPU**, the single Next.js
process that proxies every `/api` call used **0.84 of a core** (one Node process tops out near 1) and
the gateway 0.74. k6, Docker, 16 Node services and Next all share the same 12 threads here.

**Found along the way (test, not product):** polling match state every 250 ms (four times what a
real client does; the browser gets these updates over the socket) pushed write latency to ~2.3 s
p95 behind the 5-connection Postgres pools. At a realistic 1 s it's fine.

**For the server (before the VM run):**

1. Let Caddy send `/api/*` straight to the gateway (same origin, the gateway is already the hardened
   edge: auth, CSRF/Origin checks, rate limits). That removes the Next.js hop that's the busiest
   process here; Next keeps pages and server rendering.
2. If one gateway process gets near a core, run two behind Caddy.
3. Repeat this run on the VM at the plan's scale (2 k sockets, 200 concurrent matches) and record it
   here.
