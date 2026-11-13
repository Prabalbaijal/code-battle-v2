# Code Battle v2

Real-time 1v1 competitive coding: challenge an online player, both get the same unseen problem, and the first accepted solution wins.

v2 is a TypeScript rewrite of [Code Battle v1](https://github.com/Prabalbaijal/Code_Battle) as an event-driven microservice system in a Turborepo monorepo.

- **Architecture, decisions and roadmap:** [CODE_BATTLE_V2_PLAN.md](./CODE_BATTLE_V2_PLAN.md) (single source of truth)
- **Deploying:** [DEPLOY.md](./DEPLOY.md)
- **Status:** Phases 0–6 done (core game, rating, notifications, polish, hardening). Next: deploy, v1 data migration, AI.

## Requirements

- Node.js ≥ 22, pnpm 10 (`npm i -g pnpm@10`)
- Docker Desktop (local infrastructure and integration tests)

## Run it on your laptop

Everything runs on your machine with the **real** external services, exactly as configured in the
apps' `.env` files: code is judged by hosted **Judge0 on RapidAPI** and emails go out through
**Brevo**. Commands are for PowerShell, from the repo folder.

**Once:**

1. `pnpm install`.
2. Give every app an `.env`: copy each `apps/<app>/.env.example` to `.env` (the web app uses
   `apps/web/.env.local`).
3. In `apps/judge-service/.env`: `JUDGE0_URL=https://judge0-ce.p.rapidapi.com`,
   `JUDGE0_AUTH=rapidapi`, `JUDGE0_API_KEY=<your RapidAPI key>`.
4. In `apps/notification-service/.env`: `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY=<your key>`,
   `EMAIL_FROM=<a sender verified in Brevo>`.

5. AI (optional): in `apps/ai-service/.env`, `GROQ_API_KEY=<your key>` from
   <https://console.groq.com/keys> (free). Without it the coach, hints and tutor stay hidden. The first
   start downloads a small embedding model (~30 MB) for the tutor's search.

Keys go only into these files (they're gitignored). Never paste them anywhere else.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 start     # Docker infra + build + 17 processes
powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 stop      # Node processes (infra keeps running)
pnpm infra:down                                                          # stop the Docker infra too
```

`start` takes a few minutes the first time (it builds) and refuses to start if a key above is
missing. After a code change, `restart`; to skip the build, add `-NoBuild`; for 60-second matches
(to test timeouts), add `-ShortMatch`. Logs are in `.dev-logs\` (one file per service).

Then open **http://localhost:3000**.

**The Judge0 quota is real.** The RapidAPI free plan allows **50 requests a day** (it resets at
midnight UTC, 5:30 AM in India). A Submit uses 1–2, a Run 1, and 10 are always kept back so a
started match can finish, so you get roughly **20 judged actions a day**. When it runs out, the site
says the judge is at capacity until the reset. The script holds the judge to this limit
(`-JudgeDailyBudget` changes it if you buy a bigger plan).

### Play a match with yourself

You need two players, so use **two browser sessions**: a normal Chrome window and an Incognito
window (or Chrome and Edge). Each keeps its own login.

1. **Register** in each window with **email addresses you can open**: verification emails are
   really sent. With Gmail, one inbox gives you both: `yourname+p1@gmail.com` and
   `yourname+p2@gmail.com` both arrive at `yourname@gmail.com`. (Don't use made-up addresses:
   bounced emails hurt your Brevo sender reputation.)
2. **Verify** each account from the email's link.
3. Log in, then **Lobby** → the other player appears under online players → **Challenge** → accept
   in the other window.
4. In the battle room, write a real solution. The local problems are "Pair sums": the first line is
   `t`, then `t` lines `a b`; print `a + b` for each. Accepted in Python:

   ```python
   import sys
   data = sys.stdin.read().split()
   t = int(data[0])
   print("\n".join(str(int(data[1 + 2 * i]) + int(data[2 + 2 * i])) for i in range(t)))
   ```

   For a wrong answer, use C++ with `int` (the values go up to 10¹², so `int` overflows and you
   get "Wrong answer on case …"). Every Submit costs real quota, so plan your tests.

5. Try the rest: forfeit, leave and rejoin (refresh the page), a second tab ("Use here"), the
   leaderboard, your profile (coin chart, history), notifications, friends.

A match needs a **published problem neither player has seen**; each new pair can play as many
matches as there are published problems. To author more, make yourself an admin and use
**Problems** in the header:

```powershell
pnpm --filter @cb/identity-service set-role <your-username> admin     # then log out and in again
```

A problem needs 3 test files (sample, small, large), a C++ reference solution that is accepted and
a slow one that must time out (e.g. a brute force), before calibration lets you publish.
Calibration runs every reference on Judge0, about one request per reference.

### Fake mode (no quota, no emails)

`dev-stack.ps1 start -Fake` swaps in **fake-judge0** and a **fake email inbox**. The Playwright E2E
suite and the k6 load test need this mode (they register many players and submit hundreds of times).
In fake mode:

- read a "sent" email with
  `(Invoke-RestMethod "http://localhost:4003/internal/dev/inbox?to=me1@example.com").items[0].text`;
- code isn't run: a comment tells fake-judge0 the result, e.g. `# @fake program=sum-cases`
  (Accepted on Pair sums), `wrongCase=3`, `time=20` (TLE), `status=CE`, `delay=5000`. Every
  directive is listed in `apps/fake-judge0/src/directives.ts`.

### Handy local tools

| What                      | Where                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| API docs (Swagger)        | http://localhost:8080/docs                                                                                             |
| Kafka topics and messages | http://localhost:8081 (Redpanda Console)                                                                               |
| Traces                    | http://localhost:16686 (Jaeger)                                                                                        |
| Metrics dashboard         | `docker compose -f infra/docker-compose.yml --profile obs up -d`, then http://localhost:3001 (Grafana)                 |
| Database                  | `docker exec -it code-battle-postgres-1 psql -U cb -d <identity\|users\|battle\|problem\|judge\|rating\|notification>` |

### Tests

```powershell
pnpm test             # unit tests
pnpm test:int         # integration tests (Testcontainers; needs Docker)
pnpm --filter @cb/web e2e        # Playwright end to end (needs the stack running with -Fake)
pnpm --filter @cb/web budgets    # first-load JS budgets (after a web build)
```

Chaos drills (`apps/web/e2e/chaos/`, results in [docs/chaos-drills.md](./docs/chaos-drills.md)) and
the k6 load test ([load/README.md](./load/README.md)) also run against this local stack, in fake
mode (otherwise they would burn the whole Judge0 quota and send hundreds of emails).

### The production setup, locally

To try the real production build (Caddy with HTTPS, Docker images, real Judge0 and real email)
before you have a server, see "Try it on your laptop first" in [DEPLOY.md](./DEPLOY.md). Stop the
dev stack first: both use the same ports.
