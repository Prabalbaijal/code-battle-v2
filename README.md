# Code Battle v2

Real-time 1v1 competitive coding: challenge an online player, both get the same unseen problem, and the first accepted solution wins.

v2 is a TypeScript rewrite of [Code Battle v1](https://github.com/Prabalbaijal/Code_Battle) as an event-driven microservice system in a Turborepo monorepo.

- **Architecture, decisions and roadmap:** [CODE_BATTLE_V2_PLAN.md](./CODE_BATTLE_V2_PLAN.md) (single source of truth)
- **Deploying:** [DEPLOY.md](./DEPLOY.md) · **Interview guide:** [docs/INTERVIEW_GUIDE.md](./docs/INTERVIEW_GUIDE.md)
- **Status:** Phases 0–6 done (core game, rating, notifications, polish, hardening). Next: deploy, v1 data migration, AI.

## Requirements

- Node.js ≥ 22, pnpm 10 (`npm i -g pnpm@10`)
- Docker Desktop (local infrastructure and integration tests)

## Run it on your laptop

Everything runs locally with a **fake judge** (fake-judge0: no Judge0 quota used) and a **fake email
inbox** (no real emails sent). Commands are for PowerShell, from the repo folder.

**Once:** `pnpm install`, and give every app an `.env` (copy each `apps/<app>/.env.example` to
`.env`; the web app uses `apps/web/.env.local`).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 start     # Docker infra + build + 17 processes
powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 stop      # Node processes (infra keeps running)
pnpm infra:down                                                          # stop the Docker infra too
```

`start` takes a few minutes the first time (it builds). After a code change, `restart`; to skip the
build, add `-NoBuild`; for 60-second matches (to test timeouts), add `-ShortMatch`. Logs are in
`.dev-logs\` (one file per service).

Then open **http://localhost:3000**.

### Play a match with yourself

You need two players, so use **two browser sessions**: a normal Chrome window and an Incognito
window (or Chrome and Edge). Each keeps its own login.

1. **Register** in each window (any made-up email, e.g. `me1@example.com` and `me2@example.com`).
2. **Verify the email.** Nothing is really sent; read the fake inbox and open the link it shows:
   ```powershell
   (Invoke-RestMethod "http://localhost:4003/internal/dev/inbox?to=me1@example.com").items[0].text
   ```
3. Log in, then **Lobby** → the other player appears under online players → **Challenge** → accept
   in the other window.
4. In the battle room, fake-judge0 doesn't really run your code: a comment in the code tells it
   what to do. The local problems are all "Pair sums", so (Python):
   - **Accepted:** `# @fake program=sum-cases` (prints the right sums)
   - **Wrong answer on case 3:** `# @fake program=sum-cases wrongCase=3`
   - **Time limit:** `# @fake program=sum-cases time=20` · **Compile error:** `# @fake status=CE`
     · **Runtime error:** `# @fake status=NZEC`
   - **Slow judging** (to watch "judging…" and opponent activity): add `delay=5000`

   Use `//` instead of `#` in C++, Java and JavaScript. Every directive is listed at the top of
   `apps/fake-judge0/src/directives.ts`.

5. Try the rest: forfeit, leave and rejoin (refresh the page), a second tab ("Use here"), the
   leaderboard, your profile (coin chart, history), notifications, friends.

A match needs a **published problem neither player has seen**; each new pair can play as many
matches as there are published problems. To author more, make yourself a problem setter and use
**Problems** in the header:

```powershell
pnpm --filter @cb/identity-service set-role <your-username> admin     # then log out and in again
```

A problem needs 3 test files (sample, small, large), a C++ reference solution that passes
(`// @fake program=sum-cases time=0.2`) and one that must time out
(`// @fake program=sum-cases time=20`) before calibration lets you publish.
`apps/web/e2e/admin-problems.spec.ts` authors a whole "Pair sums" problem step by step: copy its
test files and references.

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
pnpm --filter @cb/web e2e        # Playwright end to end (needs the stack running)
pnpm --filter @cb/web budgets    # first-load JS budgets (after a web build)
```

Chaos drills (`apps/web/e2e/chaos/`, results in [docs/chaos-drills.md](./docs/chaos-drills.md)) and
the k6 load test ([load/README.md](./load/README.md)) also run against this local stack.

### The production setup, locally

To try the real production build (Caddy with HTTPS, Docker images, real Judge0 and real email)
before you have a server, see "Try it on your laptop first" in [DEPLOY.md](./DEPLOY.md). Stop the
dev stack first: both use the same ports.
