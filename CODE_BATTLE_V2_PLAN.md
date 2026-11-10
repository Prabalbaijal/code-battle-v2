# Code Battle v2: Architecture and Implementation Plan

> **Status:** Approved plan, not started. **Last updated:** 2026-11-08.
> **Owner:** Prabal Baijal.
> **Purpose:** This is the single source of truth for rewriting Code Battle (v1: JS/MERN in `Client/` and `Server/`) into a TypeScript Turborepo of microservices. It is written so that **any engineer or AI coding agent can pick it up cold and continue**. Every decision, and the reason for it, is recorded here.

---

## 0. How to use this document (read first, especially if you are an AI agent)

1. **Read sections 1–4 before touching code.** They explain what the product does today, what must stay the same, and what is broken.
2. **Follow the roadmap in §25 in order.** Each phase has tasks and a Definition of Done. Update the **progress tracker (§29)** when you finish a task.
3. **Don't re-open decisions marked as ADRs (§26)** unless the owner asks. If you must deviate, add a new ADR entry that explains why.
4. **Budget constraint:** this is a personal project. The target spend is **₹0/month**. Prefer free tiers and self-hosting on one free VM. Never add a paid dependency without flagging it.
5. **Code execution uses the hosted Judge0 API only.** We do **not** self-host a compiler or sandbox (see §14).
6. **Hard rules for all code:**
   - TypeScript `strict`, ESM, no `any` (use `unknown` and narrow it).
   - Validate every boundary with **zod**: HTTP bodies, query params, env vars, Kafka events, socket payloads, and Judge0 responses.
   - **Never trust identity from a request payload.** The user ID always comes from the verified token.
   - Enforce invariants with **database constraints and conditional updates**, not with Redis locks.
   - **Never write to the DB and publish an event as two separate steps.** Use the transactional outbox (§10).
   - Every consumer and job handler must be **idempotent** (§12).
7. **v2 lives in its own Git repository** (`code-battle-v2`, a sibling folder of the v1 `Code_Battle` repo). The v1 repo keeps running until the cutover (Phase 8). The migration script (§24) reads the v1 MongoDB, not v1 code. **This file, in the v2 repo, is the source of truth.** The copy in the v1 repo is historical.
8. **Package scope is `@cb/*`** (e.g. `@cb/logger`, `@cb/contracts`).
9. **Git workflow:**
   - Remote: `git@github-personal:Prabalbaijal/code-battle-v2.git`. The `github-personal` SSH alias selects the owner's personal key; other aliases on the machine belong to other accounts.
   - Agents may commit and push at checkpoints. Messages are **1–2 lines**, Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`). **No `Co-Authored-By` or any AI attribution, anywhere.**
   - Each phase gets its own branch (`phase-N/<slug>`) and is merged into `main` with a PR after its Definition of Done passes.

---

## 1. Context and goals

**Product:** Code Battle is a real-time 1v1 competitive coding game.

- You challenge an online user, and both players get the same unseen problem.
- The **first to get an accepted solution wins** coins. A 30-minute timer runs.
- The game also has friends, a leaderboard, profiles with match history, and an admin page for adding problems.

**Goals of v2**

- Same core functionality, rebuilt with **production-grade system design**: microservices, event-driven architecture, idempotency, race-condition safety, horizontal scalability, observability.
- **TypeScript everywhere**, in a **Turborepo monorepo** (layout inspired by the owner's Redingle `aa-services` repo, with differences explained in §7).
- **Interview-ready depth.** Every component has a clear "why", trade-offs, and failure handling (§27).
- **AI features** that add real value: GenAI, RAG, agents (§22).
- **₹0 hosting** for test and demo (§23).

**Non-goals (for now)**

- Self-hosting a judge or sandbox.
- Kubernetes in the live demo (manifests are optional and for showcase only).
- Native mobile apps.
- Contests with more than 2 players.

---

## 2. Current system snapshot (v1)

| Area           | v1 implementation                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend       | React 18 + Vite SPA (`Client/`), Redux Toolkit + redux-persist, react-router v6, Tailwind, Monaco and CodeMirror (both installed), socket.io-client, recharts, react-hot-toast. Deployed on Vercel.                                                                                                                                                                                                              |
| Backend        | One Express server (`Server/index.js`), Mongoose/MongoDB, Socket.IO with `@socket.io/redis-adapter` (ioredis), JWT in a cookie (1 day), bcryptjs, multer (disk) + Cloudinary for avatars, SendGrid/nodemailer for email. Deployed on Render.                                                                                                                                                                     |
| Code execution | Judge0 CE via RapidAPI. The server loops over test cases one at a time, POSTs each, then polls every 2 s (`Server/controllers/QuestionControllers.js`).                                                                                                                                                                                                                                                          |
| Timers         | Redis key with TTL `contest:<roomName>` + keyspace notifications (`__keyevent@0__:expired`).                                                                                                                                                                                                                                                                                                                     |
| Models         | `User` (fullname, username, email, password, avatar, coins=400, level=1, isAdmin, isVerified, reset and verification tokens), `Contest` (roomName, user1, user2 as usernames, status, winner, startTime, endTime, problemId), `Question` (title, description, difficulty, inputFormat, outputFormat, examples, constraints, testCases, executionTimes per language_id), `Friend` (requester, recipient, status). |
| Languages      | JavaScript (Judge0 id 63), Python (71), C++ (52), Java (62). The IDs are hard-coded in the client in `Problem.jsx#getLanguageId`.                                                                                                                                                                                                                                                                                |

### v1 socket events (all business logic currently lives in socket handlers)

| Client → server                                                                                                                              | Server → client                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playRequest`, `challengeRejected`, `cancelChallenge`, `roomCreationStarted`, `joinRoom`, `reconnectContest`, `solveProblem`, `leaveContest` | `playNotification`, `requestSent`, `opponentOffline`, `challengeRejected`, `challengeCancelled`, `roomCreating`, `startContest`, `reconnectContest`, `contestEnded`, `contestError`, `getOnlineUsers` |

### v1 REST routes

- **Auth:** `/api/auth/register` (multipart, avatar required), `/login`, `/logout`, `/getUser`, `/forgot-password`, `/reset-password/:token`, `/verify/:token`
- **Users:** `/api/users/updateprofile` (GET profile + match history), `/search`, `/leaderboard`
- **Friends:** `/api/friends/getfriendrequests`, `/sendfriendrequest`, `/handleRequest`, `/getfriends`, `/remove`
- **Questions:** `/api/questions/submit`, `/add-question`
- **Contests:** `/api/contest/activecontests`

### v1 frontend components

HomePage (+TypingEffect), Login/Register, EmailVerification, ForgotPassword/ResetPassword, MainSection, Matching/Match (lobby: online friends + other online users), Friends, FriendRequest, LeaderBoard (with online dots), Profile (ProfileHeader, Stats, PerformanceGraph, ContestHistory), Problem (ProblemDescription, CodeEditor, LanguageSelector, Navbar, Timer), ActiveContests, NotificationPanel, AddQuestion (admin), MultitabAlert, ProtectedRoutes (adminOnly).

---

## 3. Functional parity checklist (v2 must keep all of this)

Mark these off in Phase 5 and Phase 8. "Δ" marks an intended behaviour change.

- [ ] Register with fullname, username, email, password (+confirm), and an avatar. **Δ:** avatar optional; a default avatar is generated.
- [ ] Email verification is required before playing. Forgot/reset password by emailed link.
- [ ] Login, logout, and "get current user".
- [ ] New users start with **400 coins, level 1**.
- [ ] Search users by username (top 10 results). **Δ:** cursor pagination.
- [ ] Friend requests: send, list incoming, accept, reject (`ignored`), remove a friend, list friends.
- [ ] Lobby shows **online friends** and **other online users**, each with an "in contest" flag. You can challenge any online user. **Δ:** online friends update live; other online players are a **paginated, searchable list** with an online count, refreshed every 15 s instead of a global broadcast (§13.3, ADR-013).
- [ ] Challenge flow: send → the opponent gets a notification → accept, reject, or cancel by the sender → "room creating" → match starts for both players.
- [ ] A challenge is refused if the challenger **or the opponent** is already in an active match. **Δ:** v1 only checked the challenger.
- [ ] A match gives both players the **same problem, unseen by either of them** (not used in any of their previous contests).
- [ ] Match duration is **30 minutes**. The timer is shown to both players.
- [ ] Submit code in JS, Python, C++ or Java. It is judged against hidden tests.
- [ ] **The first accepted solution wins.** Winner gets **+50 coins**, loser gets **−50** (floored at 0).
- [ ] **Leave/forfeit:** the leaver loses (−50) and the opponent wins (+50).
- [ ] **Timeout with no winner:** both players get **−50** (floored at 0).
- [ ] **Level from coins:** `<500 → 1`, `<900 → 2`, `<1000 → 3`, else `4`.
- [ ] Reconnecting to an active match after a refresh or disconnect restores the problem and the remaining time.
- [ ] Active contests list (for rejoining).
- [ ] Leaderboard: top 50 (admins excluded), plus your own rank, with online indicators.
- [ ] Profile: level, coins, match history (opponent, result win/lose/draw, coin delta, date), and a performance graph.
- [ ] Multi-tab: warn the user when a battle is open in another tab.
- [ ] Admin only: add a question (title, description, difficulty Easy/Medium/Hard, input/output format, examples with explanation, constraints, tests, per-language time limits). **Δ:** now through a problem-authoring flow with test files and calibration (§14).
- [ ] Notification panel (friend requests, challenges).

---

## 4. Audit of v1 (bugs and design flaws that v2 must fix)

Use these as the "before" story in interviews.

| #   | Issue                                                                                                                                                                                                                                                                       | Location                                                                                | Class                | v2 fix                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| 1   | **The client decides the winner.** The client calls `/submit`, then emits `solveProblem` with a `userName` taken from its own payload. Any client can emit it and win. `leaveContest` also trusts `userName`, so you can make your opponent forfeit.                        | `socket.js` `solveProblem`/`leaveContest`; `Problem.jsx`                                | Security / integrity | The server decides the winner from judge verdicts (§11.3). Identity comes from the token. |
| 2   | **Hidden test cases are sent to the client**, and the client sends them back to `/submit`, along with the time limits. Players can fake tests and limits.                                                                                                                   | `getQuestion` returns the full doc; `Problem.jsx` submits `testCases`, `executionTimes` | Security             | Tests never leave the server. Limits are read from the DB (§14).                          |
| 3   | `joinRoom` accepts any `roomName`. Any socket can force a match between two online users. The accept step is never validated server-side.                                                                                                                                   | `socket.js` `joinRoom`                                                                  | AuthZ                | Challenge state machine in the DB (§11.1).                                                |
| 4   | Check-then-insert race (TOCTOU) when starting a contest, with no unique index. Two contests can be created, and A→B and B→A can both be accepted.                                                                                                                           | `joinRoom`                                                                              | Race                 | `user_active_match` PK + conditional updates (§12).                                       |
| 5   | `user1.save({session})` / `user2.save` are not awaited inside a transaction.                                                                                                                                                                                                | `UserUpdate.js#updateUserDataOnNoWinner`                                                | Correctness          | Atomic SQL + ledger.                                                                      |
| 6   | Coins are updated by read-modify-write (`findOne` → `+=` → `save`), so concurrent updates are lost.                                                                                                                                                                         | `UserUpdate.js`                                                                         | Race                 | `UPDATE … SET coins = GREATEST(coins + $d, 0)` + idempotent ledger.                       |
| 7   | `contestEnded` is emitted **before** `commitTransaction`. If the commit fails, the users have already been told the wrong result.                                                                                                                                           | `solveProblem`, `leaveContest`                                                          | Consistency          | Notify only after commit, via outbox → Kafka.                                             |
| 8   | Timers rely on Redis keyspace notifications. They are fire-and-forget, can arrive late, are lost if no subscriber is connected, and **every instance receives each event**, so expiry is processed more than once.                                                          | `socket.js` psubscribe                                                                  | Reliability          | BullMQ delayed job with `jobId` + a Postgres reconciler (§11.4).                          |
| 9   | `rescheduleAllTimeouts()` is called without the Redis client, so it silently fails on every restart.                                                                                                                                                                        | `index.js`                                                                              | Bug                  | Removed; covered by the reconciler.                                                       |
| 10  | `io.sockets.sockets.get(id)` only finds sockets on the local node. It breaks when scaled out.                                                                                                                                                                               | `joinRoom`                                                                              | Scalability          | Per-node delivery to `user:{id}` rooms (§13).                                             |
| 11  | `user:sockets` maps a username to **one** socket. A second tab overwrites the first, closing one tab marks the user offline, and a server crash leaves ghost users online. Any disconnect also removes the user from `contest:users` even though the match is still active. | `socket.js`                                                                             | Correctness          | Presence keyed per connection with a TTL (§13.3).                                         |
| 12  | `updateOnlineUsers` broadcasts **every user's** status to **every user** on each connect/disconnect, with an N+1 `sismember` loop.                                                                                                                                          | `socket.js`                                                                             | O(N²)                | Push updates only to friends; lobby list is paginated (§13.3).                            |
| 13  | `getQuestion` loads all past contests of both users into memory, then does `$nin` + `$sample`.                                                                                                                                                                              | `QuestionControllers.js`                                                                | Performance          | `user_problem_seen` + `NOT EXISTS` + `random_key` (§9.3).                                 |
| 14  | Leaderboard sorts by `coins` with no index. Rank uses `countDocuments`, which is O(N).                                                                                                                                                                                      | `UserControllers.js`                                                                    | Performance          | Redis ZSET + indexed fallback (§15).                                                      |
| 15  | Search uses an unanchored `$regex` with option `i`, which scans the whole collection.                                                                                                                                                                                       | `searchUsers`                                                                           | Performance          | `pg_trgm` / prefix index.                                                                 |
| 16  | IDOR: `activecontests` takes `username` from the body. `sendrequest` and `handleFriendRequest` take `senderUsername`/`receiverUsername` from the body, so anyone can send or accept requests as another user.                                                               | Controllers                                                                             | Security             | The acting user always comes from the token.                                              |
| 17  | `add-question` only checks that the user is logged in, not that they are an admin.                                                                                                                                                                                          | `QuestionRoutes.js`                                                                     | AuthZ                | RBAC (§16).                                                                               |
| 18  | JWT lasts 1 day with no refresh or revocation. Socket auth queries the DB on every connect. Body limit is 50 MB.                                                                                                                                                            | `AuthControllers`, `index.js`                                                           | Security / perf      | Access + refresh tokens, JWKS, small body limits.                                         |
| 19  | Judge loop is sequential per test with 2 s polling. TLE is only checked for test index 1. "In Queue" (status 1) is treated as final. Exact string compare of output. A null `time` becomes 0.                                                                               | `submitQuestion`                                                                        | Correctness / perf   | Batched, staged, checker-based judging (§14).                                             |
| 20  | Contests store usernames instead of IDs. `roomName = "a-b"` is split on `-`, which breaks for usernames containing `-`.                                                                                                                                                     | `ContestModel`, `socket.js`                                                             | Data integrity       | UUID IDs everywhere.                                                                      |
| 21  | Profile shows a score of 0 for a "draw" (timeout), but coins were actually −50 for both.                                                                                                                                                                                    | `getUserProfile`                                                                        | Bug                  | History reads deltas from the coin ledger.                                                |
| 22  | multer stores uploads by `file.originalname` (files can overwrite each other, no type or size checks), and the files stay on local disk.                                                                                                                                    | `middlewares/multer.js`                                                                 | Security             | Signed direct upload to Cloudinary/R2.                                                    |
| 23  | No friendship uniqueness constraint. A→B and B→A requests can both exist.                                                                                                                                                                                                   | `friendRequest.js`                                                                      | Race                 | Canonical pair PK (§9.2).                                                                 |
| 24  | Hard-coded CORS origins, `console.log` used as logging, no tests.                                                                                                                                                                                                           | Everywhere                                                                              | Ops                  | Env config, pino, test pyramid.                                                           |

---

## 5. Target architecture

```
                 ┌──────────── Vercel (Next.js web, SSR/ISR) ────────────┐
Browser ──HTTPS──► Next.js  ── rewrites /api/* (same-origin cookies) ──┐  │
   │                                                                   ▼  │
   │                                   Caddy (TLS) on Oracle VM ──► API Gateway (Fastify)
   │                                                         JWT verify (JWKS), rate limit, request-id, routing, BFF
   │                                                                   │ REST (commands + queries)
   │      ┌─────────────┬──────────────┬──────────────┬───────────────┼──────────────┬───────────────┬──────────────┐
   │   identity       user          battle          problem          judge           rating      notification       ai
   │   (auth)     (profiles,     (challenges,    (catalog, tests,  (intake, Judge0  (coins, levels, (in-app, email) (hints, review,
   │               friends)      matches,timers)  selection)        orchestration)   leaderboard)                    RAG tutor)
   │
   └──WSS (ticket auth)──► realtime nodes (Socket.IO, stateless, push-only, presence)
                                ▲ each node consumes Kafka with its own consumer group and emits to local sockets
Kafka (Redpanda): user.events · problem.events · battle.events · judge.events · rating.events
BullMQ (Redis): judge-submit · judge-poll · match-timeout · challenge-expire · email-send · ai-* · problem-calibrate · ...
Postgres (one logical DB per service) · Redis (cache, presence, ZSET, rate limit, BullMQ) · Cloudinary/R2 (avatars, test files, code)
Hosted Judge0 API (RapidAPI / judge0.com) ◄── judge workers (callbacks + polling fallback)
OpenTelemetry → Grafana Cloud (free) · Sentry (free)
```

### 5.1 Architecture principles (non-negotiable)

1. **Commands go over REST; WebSocket is push-only.** Challenge, accept, forfeit and submit are REST calls with idempotency keys, rate limits and standard error codes. Socket nodes only authenticate, track presence and deliver events. All the v1 bugs came from business logic living inside socket handlers.
2. **The server is authoritative.** The client never decides outcomes, time, or limits.
3. **The database is the source of truth.** Redis is only for speed. Invariants are enforced with constraints and compare-and-set updates.
4. **Events go out through a transactional outbox only.** Consumers are idempotent through an inbox table. Delivery is at-least-once and the effect is exactly-once.
5. **No distributed transactions.** Cross-service workflows are sagas with compensation steps.
6. **Database per service.** No service reads another service's DB. Data is shared through APIs or through events that build local read models.
7. **Degrade gracefully.** Losing Redis, Kafka, Judge0 or the AI provider degrades features but never corrupts data (§18).

### 5.2 Why microservices (prepared answer)

The real driver is **different scaling profiles**:

- Judge orchestration is I/O-bound, spiky, and limited by quota.
- Realtime nodes hold many connections.
- CRUD services are light.
- AI is slow and expensive.

Microservices also give fault isolation (a Judge0 or AI outage doesn't affect login) and independent deploys.

The honest caveat for a 1–2 person team: a modular monolith with the same boundaries is a valid alternative. This repo uses microservices deliberately, to demonstrate the patterns. Services stay small, and shared infrastructure lives in `packages/libs`.

---

## 6. Tech stack (final)

| Concern                        | Choice                                                                                                                                                                                                                           | Reason                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Language                       | TypeScript 5.x `strict`, Node 22 LTS, ESM                                                                                                                                                                                        | —                                                                                                                         |
| Monorepo                       | **Turborepo + pnpm workspaces**                                                                                                                                                                                                  | Strict dependency isolation; `turbo prune` produces slim Docker images. (Redingle uses Yarn 1; we deliberately use pnpm.) |
| HTTP                           | **Fastify** (+ `fastify-type-provider-zod`)                                                                                                                                                                                      | Fast, schema-first, plugin encapsulation                                                                                  |
| Validation and contracts       | **zod**, shared in `packages/contracts`                                                                                                                                                                                          | One schema for front end, back end, events and sockets                                                                    |
| DB                             | **PostgreSQL 16**, one logical DB per service                                                                                                                                                                                    | ACID, partial unique indexes, `FOR UPDATE SKIP LOCKED`, `pg_trgm`, `pgvector`                                             |
| ORM / migrations               | **Drizzle ORM + drizzle-kit**                                                                                                                                                                                                    | Close to SQL, typed; partial indexes, `RETURNING` and row locks are explicit                                              |
| IDs                            | **UUIDv7** (`uuidv7` npm)                                                                                                                                                                                                        | Time-ordered: good B-tree locality and natural cursors                                                                    |
| Event bus                      | **Kafka API via Redpanda** (self-hosted on the VM). Aiven free Kafka is the fallback.                                                                                                                                            | Fan-out, replay, ordering per key                                                                                         |
| Kafka client                   | `kafkajs` (or `@confluentinc/kafka-javascript`), wrapped in `packages/libs/events`                                                                                                                                               | —                                                                                                                         |
| Job queue                      | **BullMQ**                                                                                                                                                                                                                       | Delays, retries/backoff, priorities, rate limiter, dedupe by `jobId`                                                      |
| Cache / presence / leaderboard | **Redis 7** (ioredis)                                                                                                                                                                                                            | —                                                                                                                         |
| Realtime                       | **Socket.IO 4** (WebSocket transport only)                                                                                                                                                                                       | —                                                                                                                         |
| Code execution                 | **Hosted Judge0 API** behind a `CodeExecutor` interface                                                                                                                                                                          | Owner will not self-host a compiler (§14)                                                                                 |
| Auth                           | **Argon2id** (`@node-rs/argon2`), **EdDSA JWT** (`jose`), rotating opaque refresh tokens                                                                                                                                         | —                                                                                                                         |
| Email                          | `EmailProvider` interface: Resend or Brevo free tier (verify current limits); SendGrid adapter kept                                                                                                                              | —                                                                                                                         |
| Files                          | Cloudinary (existing) through a `StorageProvider` interface, with signed direct uploads. Cloudflare R2 for test files and code blobs.                                                                                            | —                                                                                                                         |
| Frontend                       | **Next.js (App Router) + React + TS**, TanStack Query, Zustand, Tailwind + **shadcn/ui (Radix)**, **CodeMirror 6** editor, Framer Motion, Recharts                                                                               | §21                                                                                                                       |
| AI                             | **LangChain.js + LangGraph.js** in `ai-service`. Anthropic Claude (`claude-haiku-5-5` for cheap/high-volume calls, `claude-sonnet-5-5` for reasoning-heavy work). Local embeddings via **transformers.js** (free). **pgvector**. | §22                                                                                                                       |
| Logging                        | pino (JSON), with request-id and trace-id fields                                                                                                                                                                                 | —                                                                                                                         |
| Tracing / metrics              | OpenTelemetry SDK → OTel Collector → Grafana Cloud free; Prometheus metrics; Sentry                                                                                                                                              | —                                                                                                                         |
| Testing                        | Vitest, Testcontainers (Postgres, Redis, Redpanda), Playwright, k6 (HTTP + WebSocket), `apps/fake-judge0`                                                                                                                        | —                                                                                                                         |
| Lint / format                  | ESLint (flat config, `typescript-eslint`, `eslint-plugin-boundaries`), Prettier, husky + lint-staged                                                                                                                             | —                                                                                                                         |
| CI/CD                          | GitHub Actions + Turbo cache; multi-arch (arm64) images pushed to GHCR; deploy by SSH + `docker compose`                                                                                                                         | —                                                                                                                         |

---

## 7. Monorepo layout and conventions

```
code-battle-v2/  (separate repo; v1 stays in the Code_Battle repo until cutover)
├─ apps/
│  ├─ web/                    # Next.js App Router (Vercel)
│  ├─ gateway/                # Fastify edge: auth verify, rate limit, routing, BFF aggregation
│  ├─ realtime/               # Socket.IO nodes + presence HTTP API
│  ├─ identity-service/
│  ├─ user-service/           # profiles, friends, search
│  ├─ battle-service/         # src/index.ts (API) + src/worker.ts (timers, consumers, outbox relay, reconciler)
│  ├─ problem-service/        # API + worker (calibration)
│  ├─ judge-service/          # API (intake + Judge0 callbacks) + worker (dispatch, poll, aggregate)
│  ├─ rating-service/         # consumer + leaderboard API
│  ├─ notification-service/   # consumer + email worker + API
│  ├─ ai-service/             # API (SSE) + worker
│  └─ fake-judge0/            # test double of the Judge0 API (dev / CI / load tests)
├─ packages/
│  ├─ contracts/              # kind: contracts — zod: http/, events/ (versioned), socket/ (typed maps), errors.ts
│  ├─ domain/
│  │  ├─ match-rules/         # pure: challenge + match state machines, winner resolution
│  │  ├─ scoring/             # pure: coins (+50/−50/floor), levels, (later) Glicko-2
│  │  └─ judge-core/          # pure: verdict classification, Judge0 status mapping, checkers (tokens/float/exact)
│  ├─ libs/
│  │  ├─ logger/  errors/  env/  ids/ (uuidv7)
│  │  ├─ http-server/         # fastify bootstrap: health/readiness, otel, error mapper, graceful shutdown, zod provider
│  │  ├─ auth/                # JWKS verifier, RBAC guards (fastify + socket), socket-ticket verify
│  │  ├─ db/                  # drizzle client factory, transaction helper (UoW), pg advisory-lock leader election
│  │  ├─ events/              # kafka producer/consumer, outbox relay, inbox dedupe, dead-letter table helpers, EventBus interface
│  │  ├─ queue/               # BullMQ factory, standard retry/backoff, job-outbox dispatcher
│  │  ├─ redis/               # client factory (role-based options), circuit breaker wrapper
│  │  ├─ idempotency/  rate-limit/  cache/ (L1 LRU + Redis, single-flight, jittered TTL)
│  │  ├─ http-client/         # undici wrapper: timeouts, retry w/ jitter, circuit breaker (opossum), trace propagation
│  │  └─ testing/             # testcontainers fixtures, factories, fake clock
│  ├─ ui/                     # shadcn components, tokens, Storybook (kind: ui)
│  └─ config/  typescript-config/  eslint-config/  tailwind-config/
├─ infra/
│  ├─ docker-compose.yml      # local: postgres, redis, redpanda, redpanda-console, fake-judge0, otel-collector
│  ├─ docker-compose.prod.yml # VM deploy (§23)
│  ├─ caddy/Caddyfile
│  ├─ postgres/init.sql       # creates one database + role per service
│  ├─ k6/                     # load tests
│  └─ k8s/ (optional showcase: Helm charts, KEDA ScaledObjects)
├─ scripts/migrate-v1/        # Mongo → Postgres migration (§24)
├─ docs/adr/                  # one file per ADR (§26)
├─ turbo.json  pnpm-workspace.yaml  package.json  tsconfig.base.json
└─ CODE_BATTLE_V2_PLAN.md     # this file
```

### 7.1 Differences from Redingle (deliberate)

- Redingle shares DB models through `packages/data/*`. **We keep each service's schema and migrations private inside its app** (database-per-service). Only `contracts` (API, event and socket shapes) are shared.
- Redingle enforces dependency direction by convention only. We **enforce it in CI with `scripts/check-deps.mjs`**, which reads each workspace's `repo.kind` and its `@cb/*` dependencies:
  - `app` → `domain`, `libs`, `contracts`, `ui` (web only). **Never** another app.
  - `domain` → `libs` (pure helpers only), `contracts`. No I/O.
  - `libs` → other `libs` (no cycles), `contracts`.
  - `contracts` → `zod` only.
- Every `package.json` has `"repo": { "kind": "app|domain|libs|contracts|ui|config" }`, as in Redingle.
- Packages are built to `dist/` with `tsup` (or `tsc`). Apps depend on them as `workspace:*`.

### 7.2 Layering inside a service: Controller → Service → Repository

```
apps/battle-service/src/
  index.ts                 # composition root: build deps (manual DI), register routes, start
  worker.ts                # consumers, BullMQ processors, outbox relay, reconciler
  config/env.ts            # zod-validated env (fail fast)
  db/schema.ts             # drizzle tables
  db/migrations/           # drizzle-kit generated SQL (committed)
  modules/
    challenge/
      challenge.routes.ts      # fastify routes + zod schemas (thin)
      challenge.controller.ts  # HTTP ⇄ use case mapping, no logic
      challenge.service.ts     # use cases; owns the transaction boundary
      challenge.repository.ts  # SQL only; every method takes `tx`
      challenge.jobs.ts        # BullMQ processors → service
    match/ ... (same shape + match.consumers.ts for Kafka)
  outbox/                  # outbox writer (used inside transactions)
  test/
```

- **The service owns the transaction:** `db.transaction(async (tx) => { repoA.x(tx); repoB.y(tx); outbox.add(tx, evt) })`.
- **Repositories never call other repositories or services.**
- **Pure rules** (state machines, scoring, verdicts) live in `packages/domain/*` and are unit-tested without I/O.
- **Errors:** throw `AppError(code, httpStatus, details)` from `libs/errors`. One Fastify error mapper turns them into `{ error: { code, message, details, requestId } }`. Error codes are listed in `contracts/errors.ts`, e.g. `CHALLENGE_NOT_PENDING`, `USER_IN_ACTIVE_MATCH`, `OPPONENT_OFFLINE`, `JUDGE_AT_CAPACITY`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REUSED`.

### 7.3 API conventions

- Base path `/api/v1`. JSON only. Request body limit **100 KB** (code submissions **64 KB**).
- Mutations accept an **`Idempotency-Key`** header (UUID). Required on: register, challenge create/accept/reject/cancel, forfeit, submission create, friend request create, hint purchase.
- Pagination is cursor-based (`?cursor=&limit=`), returning `{ items, nextCursor }`.
- Timestamps are ISO-8601 UTC. IDs are UUIDv7 strings.
- Internal service-to-service routes live under `/internal/*`. They are not exposed by the gateway and are authenticated with a shared service token (an HMAC-signed short-lived JWT, `aud=internal`).

---

## 8. Service catalog

Each service has its own Postgres database, and an `outbox` and `processed_events` table (§10.3).

### 8.1 gateway

- **Does:** verifies access JWTs locally via the identity JWKS (cached), applies the RBAC route table, rate limiting (§17.2), request-id, CORS from env, proxying (`@fastify/http-proxy`), and BFF aggregation.
- **BFF endpoints:**
  - `GET /api/v1/bff/profile/:username` → calls user, rating and battle in parallel, each with a 300 ms timeout, and returns partial data on failure.
  - `GET /api/v1/bff/lobby` → the user's friends + presence + any active match.
- Forwards `x-user-id`, `x-user-role` and `traceparent` headers to services. Services also verify the JWT themselves (defence in depth, cheap with JWKS).

### 8.2 identity-service

- **Owns:** credentials (email, **username**, password hash, role, verification state), refresh tokens, one-time tokens, socket tickets.
- **Owns username uniqueness as well.** Registration must enforce both unique email and unique username atomically, which can't be done across two services' DBs. Usernames are **immutable** in v2. user-service keeps a replica.
- **API:**
  - `POST /auth/register`, `POST /auth/verify-email {token}`, `POST /auth/resend-verification`
  - `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`
  - `POST /auth/forgot-password`, `POST /auth/reset-password {token, password}`
  - `GET /auth/me`, `GET /.well-known/jwks.json`
  - `POST /auth/socket-ticket` → `{ ticket, url }` (§13.1)
- **Events out:** `identity.user.registered.v1`, `identity.user.verified.v1`, `identity.user.role_changed.v1`.
- **Commands out (BullMQ):** `email-send` jobs for verification and reset emails, through a job outbox. Tokens are **not** put on Kafka, because Kafka retains messages.

### 8.3 user-service

- **Owns:** profiles (replica of username, plus fullname, avatar, bio), friendships.
- **API:**
  - `GET /users/:username`, `GET /users/search?q=&cursor=`, `PATCH /users/me`
  - `POST /users/me/avatar/upload-signature` (signed direct upload), `GET /users/batch?ids=` (internal/BFF)
  - `GET /friends`, `GET /friends/requests?direction=incoming|outgoing`, `POST /friends/requests {toUserId}`
  - `POST /friends/requests/:otherUserId/accept`, `POST /friends/requests/:otherUserId/reject`, `DELETE /friends/:userId`
- **Consumes:** `identity.user.registered.v1` (creates the profile).
- **Events out:** `user.friendship.changed.v1`, `user.profile.updated.v1`.

### 8.4 battle-service (the core)

- **Owns:** challenges, matches, participants, the active-match lock, and a submission read model.
- **API:**
  - `POST /challenges {toUserId}`, `POST /challenges/:id/accept`, `POST /challenges/:id/reject`, `POST /challenges/:id/cancel`, `GET /challenges?status=pending`
  - `GET /matches/active` (for rejoin), `GET /matches/:id/state` (snapshot used for resync), `POST /matches/:id/forfeit`, `GET /matches/history?userId=&cursor=`
  - **Internal:** `GET /internal/matches/:id/participation?userId=` (used by judge intake; cached)
- **Consumes:** `judge.submission.created.v1`, `judge.submission.judged.v1`.
- **Events out:** `battle.challenge.{created,accepted,rejected,cancelled,expired}.v1`, `battle.match.{started,deciding,completed,aborted}.v1`.
- **Jobs:** `challenge-expire`, `match-timeout`. A **reconciler** loop runs with a Postgres advisory-lock leader (§11.4).
- **Calls (sync):** problem-service `POST /internal/selections`; judge-service `GET /internal/capacity` for admission control.

### 8.5 problem-service

- **Owns:** problems, test files (metadata; blobs in R2), language limits, reference solutions, calibration runs, the per-user "seen" set, per-match problem selection, and problem embeddings (AI).
- **API:**
  - `GET /problems/:slug` (public view: statement, examples, limits; **never hidden tests**)
  - `GET /problems?cursor=` (practice catalog, later phase)
  - **Admin:** `POST /admin/problems`, `PUT /admin/problems/:id`, `POST /admin/problems/:id/test-files`, `POST /admin/problems/:id/reference-solutions`, `POST /admin/problems/:id/calibrate`, `POST /admin/problems/:id/publish`
  - **Internal:** `POST /internal/selections {matchId, userIds}` (idempotent by `matchId`), `GET /internal/problems/:id/judge-spec?version=` (limits, checker, test file URIs; judge-service only)
- **Consumes:** `battle.match.started.v1` (records seen; idempotent), `judge.submission.judged.v1` (calibration runs).
- **Events out:** `problem.published.v1`, `problem.updated.v1`.

### 8.6 judge-service

- **Owns:** submissions, Judge0 runs, verdict cache, the daily Judge0 budget, and language profiles.
- **API:**
  - `POST /submissions {mode:'submit'|'run', problemId, matchId?, languageId, code, customInput?}` → **202** `{submissionId}`
  - `GET /submissions/:id`, `GET /submissions?matchId=`, `GET /languages`
  - `PUT /hooks/judge0/:runId?sig=` (public, HMAC-verified, called by Judge0)
  - **Internal:** `GET /internal/capacity` (remaining budget + circuit breaker state)
- **Events out:** `judge.submission.created.v1`, `judge.submission.progress.v1`, `judge.submission.judged.v1`.
- **Jobs:** `judge-submit`, `judge-run` (low priority), `judge-poll`, `judge-drift-check` (weekly, repeatable).

### 8.7 rating-service

- **Owns:** player stats (coins, level, wins/losses/draws, streak; rating later), coin ledger, rating history, and the leaderboard ZSET.
- **API:** `GET /leaderboard?scope=global|friends&limit=50`, `GET /leaderboard/me`, `GET /stats/:userId`, `GET /stats/:userId/history?cursor=`
- **Consumes:** `identity.user.registered.v1` (creates stats with 400 coins, level 1), `battle.match.completed.v1`, `identity.user.role_changed.v1` (admins are excluded from the leaderboard).
- **Events out:** `rating.stats.changed.v1`.
- **Jobs:** `leaderboard-rebuild`.

### 8.8 notification-service

- **Owns:** in-app notifications and the email log.
- **API:** `GET /notifications?cursor=`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `GET /notifications/unread-count`
- **Consumes:** friendship and challenge events (creates in-app notifications), `battle.match.completed.v1`.
- **Jobs:** `email-send`. Templates: verify-email, reset-password. Deduplicated by `dedupeKey`.

### 8.9 realtime

- **Owns:** WebSocket connections and presence (Redis only).
- **HTTP:** `GET /presence/online?cursor=&limit=20` (lobby list of "other online users"), `GET /presence/online/search?prefix=`, `GET /presence/online/count`, `POST /presence/query {userIds≤100}` (online dots on the leaderboard and friends list)
- **Consumes:** all topics, with **one consumer group per node** (§13.4).

### 8.10 ai-service

See §22.

---

## 9. Data model (PostgreSQL)

All tables use `uuid` primary keys (UUIDv7, generated in the app) and `timestamptz` times. Every service DB also has the tables in §10.3.

### 9.1 identity_db

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE credentials (
  user_id            uuid PRIMARY KEY,
  email              citext NOT NULL UNIQUE,
  username           citext NOT NULL UNIQUE CHECK (username ~ '^[a-zA-Z0-9_]{3,20}$'),
  fullname           text   NOT NULL,
  password_hash      text   NOT NULL,
  password_algo      text   NOT NULL DEFAULT 'argon2id' CHECK (password_algo IN ('argon2id','bcrypt')), -- bcrypt = migrated, rehash on login
  role               text   NOT NULL DEFAULT 'user' CHECK (role IN ('user','problem_setter','admin')),
  email_verified_at  timestamptz,
  status             text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','disabled')),
  failed_login_count int    NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  legacy_mongo_id    text UNIQUE,                    -- migration only
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES credentials(user_id),
  family_id   uuid NOT NULL,                 -- rotation chain; reuse ⇒ revoke whole family
  token_hash  bytea NOT NULL UNIQUE,         -- sha256(token)
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  user_agent  text, ip inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (user_id);
CREATE INDEX ON refresh_tokens (family_id);

CREATE TABLE one_time_tokens (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES credentials(user_id),
  purpose    text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- consume atomically:
-- UPDATE one_time_tokens SET used_at = now()
--  WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id;
```

### 9.2 user_db

```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE profiles (
  user_id    uuid PRIMARY KEY,                 -- same id as identity
  username   citext NOT NULL UNIQUE,           -- replica (immutable)
  fullname   text NOT NULL,
  avatar_url text,
  bio        text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_username_trgm ON profiles USING gin (username gin_trgm_ops);     -- fuzzy search
CREATE INDEX profiles_username_prefix ON profiles ((lower(username::text)) text_pattern_ops); -- prefix search

CREATE TABLE friendships (
  user_low     uuid NOT NULL,                  -- min(a,b)
  user_high    uuid NOT NULL,                  -- max(a,b)
  requested_by uuid NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending','accepted','ignored')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high),
  CHECK (requested_by IN (user_low, user_high))
);
CREATE INDEX ON friendships (user_high, status);
CREATE INDEX ON friendships (user_low, status);
```

- **Send request:** `INSERT … ON CONFLICT (user_low,user_high) DO UPDATE SET status='pending', requested_by=$me, updated_at=now() WHERE friendships.status='ignored' RETURNING *`. No row returned means it is already pending or accepted → `409`.
- **Accept:** `UPDATE … SET status='accepted' WHERE (pair) AND status='pending' AND requested_by <> $me RETURNING *`.
- **Remove:** `DELETE WHERE (pair) AND status='accepted'`.

### 9.3 problem_db

```sql
CREATE TABLE problems (
  id              uuid PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  statement_md    text NOT NULL,             -- description
  input_format_md text NOT NULL,
  output_format_md text NOT NULL,
  constraints     text[] NOT NULL DEFAULT '{}',
  examples        jsonb NOT NULL DEFAULT '[]', -- [{input, output, explanation}]
  difficulty      text NOT NULL CHECK (difficulty IN ('Easy','Medium','Hard')),
  tags            text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version         int  NOT NULL DEFAULT 1,     -- bump on any test/limit change (cache keys, rejudge)
  memory_limit_kb int  NOT NULL DEFAULT 196608, -- must be ≤ Judge0 max (validated at boot)
  output_limit_kb int  NOT NULL DEFAULT 1024,
  checker_type    text NOT NULL DEFAULT 'tokens' CHECK (checker_type IN ('tokens','float','exact')),
  float_eps       double precision,
  random_key      double precision NOT NULL DEFAULT random(), -- random selection
  calibrated_at   timestamptz,
  created_by      uuid NOT NULL,
  legacy_mongo_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX problems_published_random ON problems (random_key) WHERE status = 'published';
CREATE INDEX ON problems (difficulty) WHERE status = 'published';
CREATE INDEX ON problems USING gin (tags);

-- Few, packed test files (see §14.2). Each file holds many cases ("t test cases" format).
CREATE TABLE test_files (
  problem_id   uuid NOT NULL REFERENCES problems(id),
  ordinal      smallint NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sample','small','large')),
  case_count   int  NOT NULL,
  input_uri    text NOT NULL,                 -- R2 object key
  output_uri   text NOT NULL,
  output_case_line_counts int[],              -- null ⇒ exactly 1 output line per case
  input_bytes  int NOT NULL CHECK (input_bytes <= 2097152),  -- ≤ 2 MB (sent in Judge0 request body)
  sha256       text NOT NULL,
  PRIMARY KEY (problem_id, ordinal)
);

CREATE TABLE problem_language_limits (        -- calibrated per (problem, file, language)
  problem_id   uuid NOT NULL REFERENCES problems(id),
  ordinal      smallint NOT NULL,
  language_key text NOT NULL,                 -- 'cpp' | 'java' | 'python' | 'javascript'
  cpu_limit_ms int NOT NULL,                  -- ≤ Judge0 max cpu (validated)
  PRIMARY KEY (problem_id, ordinal, language_key)
);

CREATE TABLE reference_solutions (
  id               uuid PRIMARY KEY,
  problem_id       uuid NOT NULL REFERENCES problems(id),
  language_key     text NOT NULL,
  expected_verdict text NOT NULL CHECK (expected_verdict IN ('AC','TLE','WA')),
  code_uri         text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calibration_runs (
  id            uuid PRIMARY KEY,
  solution_id   uuid NOT NULL REFERENCES reference_solutions(id),
  ordinal       smallint NOT NULL,
  cpu_ms        int, verdict text,
  drift_factor  numeric(4,2) NOT NULL DEFAULT 1.00,
  ran_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_problem_seen (
  user_id    uuid NOT NULL,
  problem_id uuid NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, problem_id)
);

CREATE TABLE match_problem (                  -- idempotent selection per match
  match_id   uuid PRIMARY KEY,
  problem_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

**Selection query** (inside `POST /internal/selections`; on retry it returns the existing `match_problem` row):

```sql
WITH r AS (SELECT random() AS k)
SELECT p.id FROM problems p, r
WHERE p.status = 'published' AND p.random_key >= r.k
  AND NOT EXISTS (SELECT 1 FROM user_problem_seen s WHERE s.problem_id = p.id AND s.user_id = $1)
  AND NOT EXISTS (SELECT 1 FROM user_problem_seen s WHERE s.problem_id = p.id AND s.user_id = $2)
ORDER BY p.random_key LIMIT 1;
-- if no row: repeat with p.random_key < r.k (wrap-around). If still none ⇒ 409 NO_UNSEEN_PROBLEM.
```

Mark the problem as seen for both users **in the same transaction** as inserting `match_problem`, using `ON CONFLICT DO NOTHING`. Consuming `battle.match.started.v1` repeats this idempotently as a safety net.

### 9.4 battle_db

```sql
CREATE TABLE challenges (
  id         uuid PRIMARY KEY,
  from_user  uuid NOT NULL,
  to_user    uuid NOT NULL CHECK (to_user <> from_user),
  status     text NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  match_id   uuid,
  expires_at timestamptz NOT NULL,            -- created_at + 30s
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX challenges_one_pending_per_pair ON challenges (from_user, to_user) WHERE status = 'pending';
CREATE INDEX ON challenges (to_user) WHERE status = 'pending';

CREATE TABLE matches (
  id          uuid PRIMARY KEY,
  mode        text NOT NULL DEFAULT 'friendly' CHECK (mode IN ('friendly','ranked')),
  status      text NOT NULL CHECK (status IN ('created','in_progress','deciding','completed','aborted')),
  problem_id  uuid,
  started_at  timestamptz,
  ends_at     timestamptz,                    -- started_at + 30 min (server time)
  decide_deadline timestamptz,                -- set when entering 'deciding' (cap)
  ended_at    timestamptz,
  winner_id   uuid,
  end_reason  text CHECK (end_reason IN ('solved','forfeit','timeout','aborted','legacy')),
  version     int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matches_open_by_deadline ON matches (ends_at) WHERE status IN ('in_progress','deciding');
CREATE INDEX matches_stuck_created ON matches (created_at) WHERE status = 'created';

CREATE TABLE match_participants (
  match_id  uuid NOT NULL REFERENCES matches(id),
  user_id   uuid NOT NULL,
  result    text CHECK (result IN ('win','loss','draw')),
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX ON match_participants (user_id, match_id DESC);   -- history (uuidv7 ⇒ time-ordered)

CREATE TABLE user_active_match (               -- THE "one active match per user" invariant
  user_id  uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches(id)
);

CREATE TABLE match_submissions (               -- read model from judge events
  submission_id uuid PRIMARY KEY,
  match_id      uuid NOT NULL,
  user_id       uuid NOT NULL,
  submitted_at  timestamptz NOT NULL,          -- judge intake server time (fairness key)
  verdict       text,                          -- null = pending
  judged_at     timestamptz
);
CREATE INDEX ON match_submissions (match_id, submitted_at);
```

### 9.5 judge_db

```sql
CREATE TABLE language_profiles (
  language_key     text PRIMARY KEY,           -- 'cpp','java','python','javascript'
  judge0_language_id int NOT NULL,             -- resolved from GET /languages at boot (v1 used 52/62/71/63)
  default_time_factor numeric(3,1) NOT NULL,   -- cpp 1.0, java 2.0, python 3.0, javascript 1.5
  mem_overhead_kb  int NOT NULL DEFAULT 0,
  max_processes    int NOT NULL DEFAULT 1,     -- java/js need more (threads)
  enabled          boolean NOT NULL DEFAULT true
);

CREATE TABLE submissions (
  id              uuid NOT NULL,
  user_id         uuid NOT NULL,
  match_id        uuid,
  problem_id      uuid NOT NULL,
  problem_version int  NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('submit','run')),
  language_key    text NOT NULL,
  code            text NOT NULL CHECK (octet_length(code) <= 65536),
  code_hash       text NOT NULL,              -- sha256(language|normalized code)
  custom_input    text,
  status          text NOT NULL CHECK (status IN ('queued','running','done')),
  verdict         text CHECK (verdict IN ('AC','WA','TLE','MLE','RE','CE','OLE','IE')),
  failed_file     smallint, failed_case int,
  max_cpu_ms      int, max_mem_kb int,
  message         text,                       -- trimmed compile output / RE signal / etc.
  from_cache      boolean NOT NULL DEFAULT false,
  idempotency_key uuid NOT NULL,
  submitted_at    timestamptz NOT NULL DEFAULT now(),
  judged_at       timestamptz,
  PRIMARY KEY (id, submitted_at),
  UNIQUE (user_id, idempotency_key, submitted_at)
) PARTITION BY RANGE (submitted_at);           -- monthly partitions (pg_partman or a monthly job)
CREATE INDEX ON submissions (match_id, submitted_at);
CREATE INDEX ON submissions (user_id, submitted_at DESC);
CREATE INDEX ON submissions (problem_id, problem_version, code_hash) WHERE status = 'done';
-- Note: partitioned tables require the partition key in unique constraints; enforce idempotency
-- additionally via the idempotency_keys table (§10.3) which is not partitioned.

CREATE TABLE judge_runs (                       -- one row per Judge0 submission (per test file per attempt)
  id               uuid PRIMARY KEY,
  submission_id    uuid NOT NULL,
  stage            smallint NOT NULL,           -- 1 = samples+small, 2 = large
  file_ordinal     smallint NOT NULL,
  attempt          smallint NOT NULL DEFAULT 1, -- >1 only for near-miss TLE rerun / IE retry
  judge0_token     text UNIQUE,                 -- persisted immediately after POST
  status           text NOT NULL CHECK (status IN ('pending','submitted','done','failed')),
  judge0_status_id smallint,
  cpu_ms int, wall_ms int, mem_kb int,
  stdout_trunc     text,                        -- only what the checker needs (≤ output limit)
  stderr_trunc     text, compile_output text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz, completed_at timestamptz,
  UNIQUE (submission_id, file_ordinal, attempt)
);
CREATE INDEX judge_runs_awaiting ON judge_runs (submitted_at) WHERE status = 'submitted';

CREATE TABLE judge_budget_daily (
  day        date PRIMARY KEY,
  calls_used int NOT NULL DEFAULT 0,
  calls_limit int NOT NULL
);

CREATE TABLE judge_drift (
  id uuid PRIMARY KEY, language_key text NOT NULL, cpu_ms int NOT NULL, measured_at timestamptz NOT NULL DEFAULT now()
);
```

### 9.6 rating_db

```sql
CREATE TABLE player_stats (
  user_id    uuid PRIMARY KEY,
  coins      int NOT NULL DEFAULT 400 CHECK (coins >= 0),
  level      smallint NOT NULL DEFAULT 1,
  wins int NOT NULL DEFAULT 0, losses int NOT NULL DEFAULT 0, draws int NOT NULL DEFAULT 0,
  current_streak int NOT NULL DEFAULT 0,
  is_admin   boolean NOT NULL DEFAULT false,   -- excluded from leaderboard
  rating     int, rating_rd int, rating_vol numeric,   -- Glicko-2 (optional phase)
  version    int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_stats_leaderboard ON player_stats (coins DESC, user_id) WHERE is_admin = false;

CREATE TABLE coin_ledger (                      -- append-only, the audit trail
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  match_id   uuid,
  reason     text NOT NULL CHECK (reason IN ('signup_bonus','match_win','match_loss','match_timeout','forfeit_win','forfeit_loss','hint_purchase','rejudge_reversal','migration')),
  delta      int NOT NULL,                      -- requested delta
  applied    int NOT NULL,                      -- actual delta after floor at 0
  balance_after int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, user_id, reason)            -- idempotency
);
CREATE INDEX ON coin_ledger (user_id, created_at DESC);
```

### 9.7 notification_db

```sql
CREATE TABLE notifications (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, type text NOT NULL, payload jsonb NOT NULL,
  dedupe_key text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX ON notifications (user_id, created_at DESC);

CREATE TABLE email_log (
  dedupe_key text PRIMARY KEY, template text NOT NULL, to_hash text NOT NULL,
  provider_message_id text, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
```

### 9.8 ai_db

See §22.6.

### 9.9 Transaction isolation policy

- Default **READ COMMITTED** + **compare-and-set** updates (`WHERE status = …`) + `version` columns.
- `SELECT … FOR UPDATE` only when a use case must read and then decide across rows (rare).
- **SERIALIZABLE** only where an invariant spans rows and can't be expressed as a constraint. Use a retry wrapper (3 attempts, jitter) on SQLSTATE `40001` and `40P01`.

---

## 10. Messaging

### 10.1 When to use Kafka and when to use BullMQ (decided; see ADR-004)

| Kafka (events: past tense, a fact, many listeners, replayable)                                                                       | BullMQ (commands/jobs: imperative, one worker, needs delay, retry or priority)                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user registered, friendship changed, challenge created, match started/completed, submission judged, problem published, stats changed | judge a submission, poll Judge0, fire a match timeout, expire a challenge, send an email, generate an AI review, calibrate a problem, rebuild the leaderboard |

Kafka is not used for jobs:

- It has no delayed delivery.
- A slow message blocks its partition (head-of-line blocking), and acks can't happen out of order.
- Retries need extra topics.
- It has no priorities.
- Parallelism is capped by the partition count.

### 10.2 Kafka topics and events

**Budget: 5 topics, 2 partitions each.** This keeps us compatible with the Aiven free tier as a fallback. Redpanda on the VM has no such limit, but we stay within it anyway. Dead letters go to a Postgres table, not a Kafka topic.

| Topic            | Key                                             | Events (type names)                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.events`    | userId (friendship: `user_low`)                 | `identity.user.registered.v1`, `identity.user.verified.v1`, `identity.user.role_changed.v1`, `user.friendship.changed.v1`, `user.profile.updated.v1`                                                                                                                         |
| `problem.events` | problemId                                       | `problem.published.v1`, `problem.updated.v1`                                                                                                                                                                                                                                 |
| `battle.events`  | matchId (challenges: challengeId)               | `battle.challenge.created.v1`, `battle.challenge.accepted.v1`, `battle.challenge.rejected.v1`, `battle.challenge.cancelled.v1`, `battle.challenge.expired.v1`, `battle.match.started.v1`, `battle.match.deciding.v1`, `battle.match.completed.v1`, `battle.match.aborted.v1` |
| `judge.events`   | matchId, or submissionId when there is no match | `judge.submission.created.v1`, `judge.submission.progress.v1`, `judge.submission.judged.v1`                                                                                                                                                                                  |
| `rating.events`  | userId                                          | `rating.stats.changed.v1`                                                                                                                                                                                                                                                    |

**Envelope** (`packages/contracts/events/envelope.ts`):

```ts
type EventEnvelope<T> = {
  id: string; // uuidv7 — dedupe key for consumers
  type: string; // e.g. 'battle.match.completed.v1'
  source: string; // service name
  occurredAt: string; // ISO
  aggregateId: string; // matchId / userId / ...
  recipients?: string[]; // userIds that should get a realtime push (used by realtime nodes)
  traceparent?: string; // W3C trace context
  data: T; // zod-validated per type
};
```

**Key payloads:**

- `battle.match.started.v1`: `{ matchId, participants:[userId,userId], problemId, startedAt, endsAt }`
- `battle.match.completed.v1`: `{ matchId, participants, winnerId|null, endReason:'solved'|'forfeit'|'timeout', problemId, startedAt, endedAt }`
- `battle.match.aborted.v1`: `{ matchId, participants, reason }` (no coin changes)
- `judge.submission.created.v1`: `{ submissionId, matchId?, userId, problemId, mode, submittedAt }`
- `judge.submission.judged.v1`: `{ submissionId, matchId?, userId, mode, verdict, failedFile?, failedCase?, maxCpuMs?, maxMemKb?, submittedAt, judgedAt }`
- `rating.stats.changed.v1`: `{ userId, coins, level, delta, reason, matchId? }`

**Schema evolution:** additive changes keep the same version. Breaking changes publish `.v2` alongside `.v1` until every consumer has migrated.

### 10.3 Outbox, inbox, dead letters, idempotency keys (in every service DB)

```sql
CREATE TABLE outbox (
  id uuid PRIMARY KEY, topic text NOT NULL, key text NOT NULL, type text NOT NULL,
  payload jsonb NOT NULL, headers jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz, attempts int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE job_outbox (               -- same idea for BullMQ commands
  id uuid PRIMARY KEY, queue text NOT NULL, job_id text NOT NULL, name text NOT NULL,
  data jsonb NOT NULL, opts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
  UNIQUE (queue, job_id)
);
CREATE INDEX job_outbox_pending ON job_outbox (created_at) WHERE dispatched_at IS NULL;

CREATE TABLE processed_events (         -- inbox
  consumer text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE dead_letters (
  id uuid PRIMARY KEY, source text NOT NULL,        -- 'kafka:<consumer>' | 'bullmq:<queue>'
  payload jsonb NOT NULL, error text NOT NULL, attempts int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), replayed_at timestamptz
);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL, key uuid NOT NULL, route text NOT NULL,
  request_hash text NOT NULL, status text NOT NULL CHECK (status IN ('in_progress','done')),
  response_status int, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
```

**Outbox relay** (`libs/events`):

- **Immediate dispatch:** after a transaction commits, the service tries to publish its own outbox rows right away, for low latency.
- **Sweeper:** in the worker, every 2 s, `SELECT … FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED` → produce to Kafka (`acks=all`, idempotent producer) → `UPDATE published_at`.
- Ordering per aggregate is preserved by the Kafka key. The sweeper processes rows in `created_at` order.
- The job outbox works the same way, enqueuing to BullMQ with `jobId` = `job_outbox.job_id`, so duplicates are no-ops.

**Consumer pattern:**

```ts
await db.transaction(async (tx) => {
  const inserted = await tx
    .insert(processedEvents)
    .values({ consumer, eventId: evt.id })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return; // duplicate delivery ⇒ no-op
  await service.handle(tx, evt); // effect + optional outbox rows, same tx
});
// commit offset only after the tx commits. Failure ⇒ retry with backoff (in-process, 5 attempts),
// then write to dead_letters and commit the offset (don't block the partition). Replay tool: scripts/replay-dlq.ts
```

### 10.4 BullMQ queues

| Queue                                  | Owner        | jobId                             | Delay / repeat     | Retries | Notes                             |
| -------------------------------------- | ------------ | --------------------------------- | ------------------ | ------- | --------------------------------- |
| `challenge-expire`                     | battle       | `challenge-expire:{challengeId}`  | 30 s               | 5, exp  | CAS `pending → expired`           |
| `match-timeout`                        | battle       | `match-timeout:{matchId}`         | until `ends_at`    | 5, exp  | §11.4                             |
| `judge-submit`                         | judge        | `{submissionId}`                  | —                  | 5, exp  | priority 1                        |
| `judge-run`                            | judge        | `{submissionId}`                  | —                  | 3       | priority 10 (low)                 |
| `judge-poll`                           | judge        | `poll:{runId}:{n}`                | 15 s → 30 s → 60 s | —       | fallback when no callback arrives |
| `judge-drift-check`                    | judge        | repeatable weekly                 | —                  | —       | §14.8                             |
| `problem-calibrate`                    | problem      | `calibrate:{problemId}:{version}` | —                  | 3       | §14.7                             |
| `email-send`                           | notification | `{dedupeKey}`                     | —                  | 8, exp  | provider rate limiter             |
| `ai-review`, `ai-embed`, `ai-generate` | ai           | business key                      | —                  | 3       | concurrency limited, budget gated |
| `leaderboard-rebuild`                  | rating       | `lb-rebuild`                      | on boot + daily    | 3       | —                                 |

Rules:

- Queue names use hyphens, not colons.
- **The Redis instance used by BullMQ must have `maxmemory-policy noeviction`.**
- Workers use `maxRetriesPerRequest: null`.
- Every processor must be idempotent: CAS updates plus `jobId` dedupe.
- Exhausted jobs go to `dead_letters`.

---

## 11. Core flows

### 11.1 Challenge

**Challenge state machine (`packages/domain/match-rules`):**
`pending → accepted | rejected | cancelled | expired`. All four are terminal.

1. **`POST /challenges {toUserId}`** with an `Idempotency-Key`:
   - Reject if `to = me` → `400`.
   - Reject if the target is offline (presence check through realtime, or Redis directly) → `409 OPPONENT_OFFLINE`.
   - Reject if either user is in `user_active_match` → `409 USER_IN_ACTIVE_MATCH`.
   - Admission control: `GET judge /internal/capacity`. If below threshold → `503 JUDGE_AT_CAPACITY`.
   - Transaction: insert the challenge (`expires_at = now()+30s`). A duplicate pending challenge hits the partial unique index → `409 CHALLENGE_ALREADY_PENDING`. Write outbox `battle.challenge.created.v1` (recipients: `[toUser]`) and job_outbox `challenge-expire`.
   - Response `201 {challenge}`. This replaces v1's `requestSent`.
2. **Reject:** `UPDATE … SET status='rejected' WHERE id=$1 AND to_user=$me AND status='pending'` → outbox (recipients: `[fromUser]`).
   **Cancel:** the same, with `from_user=$me`.
   **Expire job:** the same with `status='expired'`. Zero rows updated means it was already handled; no-op.
3. **Accept:** see §11.2.

### 11.2 Match start saga (inside battle-service)

1. **Transaction A:**
   - `UPDATE challenges SET status='accepted', match_id=$newId WHERE id=$1 AND to_user=$me AND status='pending' AND expires_at > now() RETURNING *`.
     - 0 rows: if the challenge is already `accepted` by me, return the existing match (idempotent replay). Otherwise `409 CHALLENGE_NOT_PENDING`.
   - `INSERT matches (id, status='created')`.
   - `INSERT user_active_match` for **both** users. A PK conflict means one of them is busy: roll back → `409 USER_IN_ACTIVE_MATCH`. **This also resolves A→B and B→A accepted at the same time.**
   - Outbox `battle.challenge.accepted.v1` (recipients both). The UI shows "Preparing match…", which replaces v1's `roomCreating`.
2. **Selection:** `POST problem /internal/selections {matchId, userIds}`. Uses a 2 s timeout, 2 retries with jitter and a circuit breaker; it's idempotent by `matchId`.
3. **Transaction B:**
   - `UPDATE matches SET status='in_progress', problem_id=$p, started_at=now(), ends_at=now()+interval '30 min', version=version+1 WHERE id=$m AND status='created'`.
   - Insert both participants.
   - Outbox `battle.match.started.v1` (recipients both).
   - job_outbox `match-timeout` (delay = `ends_at - now()`).
4. **Compensation** (selection fails with `NO_UNSEEN_PROBLEM` or a breaker error): one transaction sets the match to `aborted`, `end_reason='aborted'`, deletes both `user_active_match` rows, and writes outbox `battle.match.aborted.v1`. The UI shows "Couldn't start match: no new problems available", matching v1's message.
5. **Reconciler** (§11.4) aborts matches stuck in `created` for more than 30 s, which covers a crash between steps.
6. **Response** to the accepter: `200 {matchId}`. Both clients learn about the start via `match:started` and navigate to `/battle/{matchId}`.

### 11.3 Submit → judge → winner (server-authoritative, fair)

1. **`POST /submissions {mode:'submit', matchId, problemId, languageKey, code}`** with an `Idempotency-Key`. Intake checks:
   - Participation is valid and the match is `in_progress`, via `battle /internal/matches/:id/participation` (cached in Redis until `ends_at`).
   - `now() < ends_at`. **Server time only.**
   - Rate limits: 1 submit per 5 s per user per match, at most 15 submits per user per match, and the code must differ from the user's previous submission.
   - Code is at most 64 KB and the language is enabled.
   - **Verdict cache hit** (same `problem_version + code_hash` already judged): create the submission as `done`, `from_cache=true`, and emit `judge.submission.judged.v1` straight away (**0 Judge0 calls**).
   - Otherwise: insert as `queued`, add job_outbox `judge-submit` and outbox `judge.submission.created.v1`, and return `202 {submissionId}`.
2. **Judging:** see §14. The result is `judge.submission.judged.v1` (Kafka key = matchId, so each match's events are ordered).
3. **battle-service consumer** (inbox-deduplicated) maintains `match_submissions` from created and judged events. On a judged **AC** for an open match:
   - **Fairness rule: the earliest _submitted_ AC wins, not the earliest judged**, because judging latency varies.
   - If any other submission with `submitted_at < this.submitted_at` is still pending (`verdict IS NULL`), set `status='deciding'` and `decide_deadline = now()+10 min`, emit `battle.match.deciding.v1`, and wait for the next judged event.
   - Otherwise, the winner is the user with the earliest submitted AC. In one transaction:
     - `UPDATE matches SET status='completed', winner_id=$w, end_reason='solved', ended_at=now(), version=version+1 WHERE id=$m AND status IN ('in_progress','deciding')`. **This compare-and-set is the "first writer wins" mechanism. No distributed lock is needed.**
     - Set participants' `result`, delete both `user_active_match` rows, write outbox `battle.match.completed.v1`.
   - **Clients are told only after commit**, via outbox → Kafka → realtime. This fixes v1 bug #7.
4. **rating-service** consumes `battle.match.completed.v1` (§15) and applies coins idempotently.

### 11.4 Timeout, deciding cap, and the reconciler

- **`match-timeout` job at `ends_at`:**
  - If pending submissions exist with `submitted_at < ends_at`, the match goes to `deciding` (with a cap).
  - Otherwise CAS to `completed` with `winner_id = null` and `end_reason='timeout'`. Both players get −50.
- **Deciding cap** (`decide_deadline` passes and some verdicts never arrived, e.g. Judge0 outage): resolve with the verdicts we have. If an AC exists, apply the earliest-submitted-AC rule. If none exists and verdicts are still missing, **abort with no coin change** (`battle.match.aborted.v1`).
- **Reconciler loop** (battle worker, every 15 s, leader elected via `pg_try_advisory_lock(hashtext('battle-reconciler'))`). **It does not depend on Redis or BullMQ**, so timeouts still fire when Redis is down. It:
  - aborts `created` matches older than 30 s;
  - handles `in_progress` matches with `ends_at < now() - 5s`, i.e. the timeout job was lost (same logic as the timeout job);
  - handles `deciding` matches past `decide_deadline`.

### 11.5 Forfeit (replaces `leaveContest`)

`POST /matches/:id/forfeit`. The acting user comes from the token. CAS `in_progress|deciding → completed`, `end_reason='forfeit'`, winner = the opponent. Then the same post-commit flow as §11.3.

### 11.6 Reconnect / rejoin (replaces `reconnectContest`)

- On app load, the client calls `GET /matches/active`. If a match exists, it shows a "Rejoin match" banner, or navigates there directly.
- `/battle/{id}` loads `GET /matches/:id/state` → `{ match, problem (public view), serverNow, endsAt, mySubmissions, opponentProgress, lastSeq }`. Then the socket delivers live events. A gap in `seq` triggers a refetch of the state.
- Disconnecting **does not** forfeit (same as v1). An optional `DISCONNECT_FORFEIT_SECONDS` setting is off by default.

### 11.7 Registration and email verification

1. `POST /auth/register` (username, fullname, email, password; the avatar is set afterwards with a signed upload).
2. Transaction: insert credentials (unique email and username → `409 EMAIL_TAKEN` / `USERNAME_TAKEN`), insert `one_time_tokens(verify_email, 24h)`, outbox `identity.user.registered.v1`, job_outbox `email-send {template:'verify', to, link, dedupeKey:'verify:'+tokenId}`.
3. user-service creates the profile and rating-service creates stats (400 coins, ledger `signup_bonus`), both from the event.
4. `POST /auth/verify-email {token}` consumes the token atomically and sets `email_verified_at`. Playing (challenges and submissions) requires a verified email; the claim is `ev: true` in the JWT.

### 11.8 Password reset

`POST /auth/forgot-password {email}` **always returns 200**, so accounts can't be enumerated. If the user exists, a token is created (30 min) and an email is sent. `POST /auth/reset-password` consumes the token, sets the new hash, and **revokes all refresh tokens** for that user.

### 11.9 Friend request

§9.2 SQL. Events → notification-service creates an in-app notification, and realtime pushes `notification:new` and `presence:update` (when the friend set changes).

---

## 12. Concurrency, idempotency and race-condition matrix

| Scenario                                           | Mechanism                                                                                                 | Test                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Double-click accept                                | CAS `pending → accepted` + idempotency key returns the same match                                         | 50 parallel accepts → exactly 1 match           |
| A→B and B→A accepted at the same moment            | `user_active_match` PK conflict on the second                                                             | Parallel test → 1 match, other request gets 409 |
| Duplicate pending challenge                        | Partial unique index                                                                                      | —                                               |
| Accept after expiry                                | `expires_at > now()` in the CAS                                                                           | Fake clock                                      |
| Two AC verdicts processed at the same time         | CAS on `matches.status` + earliest-submitted rule                                                         | Inject out-of-order judged events               |
| AC judged before an earlier-submitted pending one  | `deciding` state                                                                                          | Scripted fake-judge0 latencies                  |
| Timeout job and AC verdict race                    | Both use CAS; whichever commits first wins. The loser updates 0 rows and does nothing.                    | Parallel test                                   |
| Kafka redelivery of `match.completed`              | Inbox + ledger `UNIQUE(match_id,user_id,reason)`                                                          | Replay the event 5× → coins change once         |
| BullMQ job retried after a partial failure         | `jobId` dedupe + CAS updates + `judge_runs` token check                                                   | Kill the worker mid-job                         |
| Judge0 POST retried (not idempotent on their side) | Create the `judge_runs` row **before** POST; save the token immediately; on retry, poll if a token exists | Simulated timeout after POST                    |
| Friend request A→B and B→A together                | Canonical pair PK + `ON CONFLICT`                                                                         | Parallel test                                   |
| Coin floor at 0 under concurrency                  | `UPDATE … SET coins = GREATEST(coins + $d, 0)` in the same transaction as the ledger insert               | —                                               |
| HTTP retry with a different body but the same key  | `request_hash` mismatch → `422 IDEMPOTENCY_KEY_REUSED`                                                    | —                                               |
| Email sent twice                                   | `email_log.dedupe_key` PK; check before calling the provider, record after                                | —                                               |
| Two reconciler instances                           | `pg_try_advisory_lock` leader election                                                                    | Run 2 workers                                   |

**Idempotency-Key middleware** (`libs/idempotency`):

1. Look up `(user, key)`.
2. If `done` and the hash matches, replay the stored response. If `in_progress`, return `409 REQUEST_IN_PROGRESS`.
3. Otherwise insert `in_progress` (with a Redis `SET NX` fast path), run the handler, then store the response. Keys expire after 24 h.

**On distributed locks:** we do **not** use Redlock for correctness. Without fencing tokens it is unsafe under GC pauses and clock drift. Postgres constraints and CAS give stronger guarantees.

---

## 13. Realtime design

### 13.1 Connection and authentication: the socket ticket

- The web app runs on Vercel and the API on the VM. **Vercel rewrites don't proxy WebSockets**, and third-party cookies are unreliable, so the socket doesn't use cookies.
- Flow:
  1. The client calls same-origin `POST /api/v1/auth/socket-ticket` (cookie auth through the Next rewrite).
  2. It receives `{ ticket, url }`. The ticket is a JWT valid for 60 s with `aud=realtime`, `sub=userId` and a `jti`.
  3. The client connects to `wss://rt.<domain>` with `auth: { ticket }`.
- Realtime verifies the signature (JWKS) and enforces **single use** with Redis `SET jti NX EX 120`. If Redis is down, it accepts a valid unexpired ticket; the 60 s expiry limits the risk.
- Transport: `transports: ['websocket']` only, so no sticky sessions are needed.
- **Reconnect:** fetch a new ticket, with exponential backoff and jitter (max 30 s).
- On connect: `socket.join('user:' + userId)` **locally**, then register presence.

### 13.2 Delivery (no Redis adapter in the critical path)

- Each realtime node runs a Kafka consumer with **its own group id** (`realtime-{nodeId}`, so every node receives every event) and reads from the latest offset.
- For each event that has `recipients`, the node runs `io.local.to('user:'+uid).emit(type, envelope)` for each recipient. Only sockets on that node receive it.
- **Why:** there's no cross-node join or lookup, and delivery keeps working if Redis is down. This scales to several nodes; at very large scale, switch to node-targeted routing (a presence map `userId → nodeId` plus per-node topics).
- Each server→client message carries `{eventId, type, seq?, ts, data}`. Match-scoped events carry `seq = matches.version`. The client dedupes by `eventId` and resyncs when `seq` has a gap.

### 13.3 Presence

- **Per connection:**
  - `HSET presence:{userId} {connId} {nodeId}` with `PEXPIRE` 60 s.
  - `ZADD presence:online {nowMs} {userId}`.
  - The client sends `presence:ping` every 25 s to refresh both.
- On disconnect: `HDEL` the connection. If the hash is now empty, wait a **5 s debounce** before announcing offline (handles reloads and flapping).
- **Sweeper** (leader via Redis `SET NX` lock, best-effort): `ZREMRANGEBYSCORE presence:online -inf now-90s`.
- **Status** = `offline | online | in_match`. `in_match` comes from the `battle.match.started`/`completed`/`aborted` events, cached in Redis as `inmatch:{userId}`.
- **Fan-out:** a status change is pushed **only to friends.** The friend set is cached as `friends:{userId}` (SET, invalidated on `user.friendship.changed.v1`), and the event goes to each friend's `user:{friendId}` room.
- **Lobby "other online users" (decided: paginated pull, never broadcast). See ADR-013.**
  - **Why:** v1 pushed the entire online list to every client on every connect and disconnect, which is O(N²) traffic. Showing "all online users" live doesn't scale and isn't useful past about 50 names.
  - **Lobby layout:**
    1. **Online friends:** live, via push (`presence:snapshot` + `presence:update`), usually small.
    2. **Online players:** a header count ("1,234 players online", from `ZCARD presence:online`, cached for 5 s), then a **paginated list of 20 per page** sorted by most recently active (`ZREVRANGEBYSCORE presence:online +inf -inf LIMIT offset 20`, cursor = last score + userId).
    3. **Search online players by username prefix:** a second, lexicographic ZSET `presence:online:lex` (all scores 0, member `lower(username):userId`) queried with `ZRANGEBYLEX [prefix [prefix\xff LIMIT 0 20`. It is maintained alongside `presence:online`, and the sweeper removes stale members.
  - **No live push for this list.** The client refetches the current page every 15 s while the lobby tab is visible (paused when hidden) and on manual refresh. Each card shows a live `in_match` badge. The Challenge button re-checks on the server anyway (offline or busy → `409`).
  - **Endpoints:** `GET /presence/online?cursor=&limit=20`, `GET /presence/online/search?prefix=`, `GET /presence/online/count`.
  - **Optional later: "Quick Match" button** (a matchmaking queue by level), so users don't need to browse the list at all.
- **Leaderboard and friends dots:** `POST /presence/query {userIds}` → pipelined `EXISTS presence:{id}` calls.

### 13.4 Socket event catalog (`packages/contracts/socket`)

**Client → server:** `presence:ping` only. Everything else is REST.

**Server → client:**

| Event                     | Data                                                                                                   | Replaces v1                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `presence:snapshot`       | `{ friends: [{userId, username, avatarUrl, status}] }` (on connect)                                    | `getOnlineUsers`                                          |
| `presence:update`         | `{ userId, status }`                                                                                   | `getOnlineUsers`                                          |
| `challenge:received`      | `{ challengeId, from:{userId, username, avatarUrl}, expiresAt }`                                       | `playNotification`                                        |
| `challenge:updated`       | `{ challengeId, status, matchId? }`                                                                    | `challengeRejected`, `challengeCancelled`, `roomCreating` |
| `match:started`           | `{ matchId, opponent, problem(public), startedAt, endsAt, serverNow }`                                 | `startContest`                                            |
| `match:aborted`           | `{ matchId, reason }`                                                                                  | `contestError`                                            |
| `submission:progress`     | `{ submissionId, stage, status }` (submitter only)                                                     | —                                                         |
| `submission:verdict`      | `{ submissionId, verdict, failedFile?, failedCase?, maxCpuMs?, maxMemKb?, message? }` (submitter only) | REST result of `/submit`                                  |
| `match:opponent-activity` | `{ type:'submitted'                                                                                    | 'judged', verdict? }` (no code, no details)               | —              |
| `match:deciding`          | `{ matchId }`                                                                                          | —                                                         |
| `match:ended`             | `{ matchId, winnerId                                                                                   | null, endReason, coinsDelta }`                            | `contestEnded` |
| `stats:updated`           | `{ coins, level }`                                                                                     | —                                                         |
| `notification:new`        | `{ notification }`                                                                                     | —                                                         |

### 13.5 Multi-tab battle lease

- The battle page acquires `SET battle-tab:{matchId}:{userId} {tabId} NX PX 30000` through `POST /matches/:id/tab-lease`, and renews it every 10 s.
- Other tabs show the MultitabAlert with a "Use here" button, which takes the lease over.
- The client also uses a `BroadcastChannel` for instant same-browser detection.

### 13.6 Protection

- Per-connection limits: max 30 inbound events per minute, 1 KB payload cap.
- Max 5 connections per user.
- Graceful shutdown: on SIGTERM, stop accepting connections, emit `server:reconnect`, close sockets over 10 s, then exit.

---

## 14. Judge design (hosted Judge0 API only)

### 14.1 Constraints of hosted Judge0 (checked 2026-11-08; re-verify, see §28)

- Every test file run = **one Judge0 submission**, and **each one recompiles**. The hosted API has no compile-once mode.
- **Quota:**
  - RapidAPI "Basic" free plan exists, but its daily quota wasn't verified.
  - judge0.com lists paid plans: €27/mo for 2000 submissions/day, €54/mo for 5000/day (third-party report).
- **Limits** (defaults / documented custom maximums; per instance):
  - CPU default 2 s, maximum 15 s.
  - Memory default 128 MB, maximum 256 MB.
  - File (output) default 1 MB, maximum 4 MB.
  - **At boot, read `GET /config_info` and fail fast** if any problem limit exceeds the instance maximums. Read `max_submission_batch_size` from it as well (commonly 20).
- **There is no MLE status code.** MLE must be inferred (§14.5).
- `wait=true` is discouraged. **Use `callback_url` with a polling fallback.**
- Hidden test inputs are sent to Judge0 server-side. That's accepted. **They are never sent to our clients.**
- Language IDs differ between Judge0 versions. **Resolve them from `GET /languages` at boot** into `language_profiles` (v1 used cpp=52, java=62, python=71, javascript=63).

### 14.2 Test data design: few packed files (cost minimisation)

- Each problem has **3, at most 4, test files**. Each file contains many cases in the Codeforces "`t` test cases" format:
  1. `sample`: the statement examples.
  2. `small`: **every correctness and edge case** packed together.
  3. `large`: **1 file (at most 2)** for performance.
- Output: one line per case by default. If a case produces several lines, `output_case_line_counts` says how many. The checker splits the output per case, so **"Wrong answer on case 37" still works** with one Judge0 call.
- Size rules:
  - Input ≤ 2 MB per file, because it's sent in the request body.
  - Output well under the output limit: large tests should produce small outputs.
  - `cpu_limit` × language factor ≤ the instance's maximum CPU (15 s). If Python can't fit, make the large pack smaller.
- **A TLE inside a pack can't be attributed to a single case.** That's acceptable.

### 14.3 Judging stages and quota per action

| Action                            | Stage 1 (one batch POST)  | Stage 2 (one batch POST) | Max Judge0 submissions |
| --------------------------------- | ------------------------- | ------------------------ | ---------------------- |
| **Run** (samples or custom input) | `sample` (+ custom input) | —                        | 1–2                    |
| **Submit**                        | `sample` + `small`        | `large` (1–2)            | **3–4**                |

- Stage 2 runs only if stage 1 is fully AC (**fail fast**). In battles most submissions fail early, so most never reach stage 2.
- A compile error (CE) in stage 1 stops the submission immediately.
- **Estimate:** about 20–30 Judge0 calls per match (2 players × about 6 submits × a fail-fast average), versus about 120 for naive per-test judging.

### 14.4 Pipeline (non-blocking: the worker never sleeps waiting on Judge0)

```
judge-submit job(submissionId):
  CAS submissions queued→running (0 rows ⇒ already handled ⇒ return)
  spec = problem /internal/problems/:id/judge-spec?version=  (cached by problemId:version, tests cached by sha256 in Redis/local LRU)
  budget.reserve(n)  -- Redis INCRBY judge0:budget:{yyyy-mm-dd}; over limit ⇒ requeue with delay + mark 'delayed'
  insert judge_runs rows (status=pending) for stage 1 files
  POST {JUDGE0}/submissions/batch?base64_encoded=true   (body: [{source_code, language_id, stdin, cpu_time_limit, cpu_extra_time,
        wall_time_limit, memory_limit, stack_limit, max_processes_and_or_threads,
        enable_per_process_and_thread_time_limit:false, max_file_size, callback_url}])
  persist tokens immediately (status=submitted); enqueue judge-poll(runId, n=1) delayed 15s
  publish judge.submission.progress.v1 {stage:1, status:'running'}
  return  -- done; results arrive asynchronously

PUT /hooks/judge0/:runId?sig=  (public)
  verify HMAC(runId, JUDGE0_CALLBACK_SECRET) and body.token == judge_runs.judge0_token
  decode base64 fields if present; UPDATE judge_runs SET ... WHERE id=$1 AND status='submitted'
  → aggregate(submissionId)

judge-poll job(runId, n):
  if run already done ⇒ return
  GET {JUDGE0}/submissions/batch?tokens=a,b,c&base64_encoded=true&fields=token,status,time,wall_time,memory,stdout,stderr,compile_output,message
  status 1|2 (queued/processing) ⇒ re-enqueue n+1 (15s, 30s, 60s; give up after ~5 min ⇒ IE)
  else update run ⇒ aggregate(submissionId)

aggregate(submissionId):  (idempotent; row lock on the submission)
  if any run in current stage still submitted ⇒ return
  classify each run (§14.5) in file order; first non-AC decides
  near-miss TLE (cpu in (limit, 1.2×limit]) and attempt=1 ⇒ create attempt=2 run for that file, POST, return
  IE ⇒ retry that file once (attempt+1), else final IE
  stage 1 all AC and mode=submit ⇒ start stage 2
  else finalize: UPDATE submissions SET status='done', verdict, ... WHERE id=$1 AND status='running'
       outbox judge.submission.judged.v1 ; cache verdict by (problem_version, code_hash) for 7 days
```

- **Callbacks need a public HTTPS URL** (the VM behind Caddy). In local dev, set `JUDGE0_MODE=poll`.
- **Circuit breaker on the Judge0 client:** 5 consecutive failures or 50% errors over 30 s → open for 30 s.
  - While it is open, submissions stay `queued` with `message='judging delayed'`, and **battle admission control refuses new matches.**
  - Running matches are protected by the `deciding` state and the deciding cap (§11.4).
- **Retries:** network errors and 5xx use exponential backoff with jitter. A 429 honours `Retry-After`. Other 4xx are fatal → IE + alert.

### 14.5 Verdict classification (`packages/domain/judge-core`)

**Request limits per file:**

| Parameter                                  | Value                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `cpu_time_limit`                           | `limitSec` = calibrated `problem_language_limits.cpu_limit_ms` (fallback: base × language factor) × drift factor |
| `cpu_extra_time`                           | `max(0.5, 0.1 × limitSec)`: grace, so near-miss times are visible                                                |
| `wall_time_limit`                          | `3 × limitSec + 1`: backstop for sleeping or blocked programs                                                    |
| `memory_limit`                             | `problem.memory_limit_kb + lang.mem_overhead_kb` (≤ instance maximum)                                            |
| `stack_limit`                              | Same as the memory limit, capped by the instance                                                                 |
| `max_processes_and_or_threads`             | `lang.max_processes`                                                                                             |
| `enable_per_process_and_thread_time_limit` | `false` (CPU time is counted across all threads)                                                                 |
| `max_file_size`                            | `problem.output_limit_kb`                                                                                        |
| `expected_output`                          | **Never sent.** Our checker decides AC/WA.                                                                       |
| `number_of_runs`                           | `1`                                                                                                              |

**Judge0 `status.id` → our verdict (first match wins):**

```ts
export function classifyRun(
  r: Judge0Result,
  lim: { cpuSec: number; wallSec: number; memKb: number },
): Verdict | 'CHECK' {
  const id = r.status.id;
  if (id === 13 || id === 14) return 'IE'; // internal / exec format error → retry
  if (id === 6) return 'CE';
  const cpu = r.time == null ? null : Number(r.time); // CPU seconds (string in API)
  const wall = r.wall_time == null ? null : Number(r.wall_time);
  if (id === 5 || (cpu != null && cpu > lim.cpuSec) || (wall != null && wall > lim.wallSec)) return 'TLE';
  if (id === 8) return 'OLE'; // SIGXFSZ
  const memHit = r.memory != null && r.memory >= 0.95 * lim.memKb;
  const oomText = /OutOfMemoryError|MemoryError|std::bad_alloc|heap out of memory/i.test(r.stderr ?? '');
  if (id >= 7 && id <= 12) return memHit || oomText ? 'MLE' : 'RE'; // SIGSEGV/SIGFPE/SIGABRT/NZEC/Other
  if (id === 3) return 'CHECK'; // ran cleanly → run checker → AC | WA
  if (id === 1 || id === 2) throw new Error('not final'); // never classify queued/processing
  return 'IE';
}
```

- **Checkers:**
  - `tokens` (default; whitespace-insensitive, like Codeforces' `wcmp`).
  - `float` (absolute/relative epsilon).
  - `exact`.
  - The checker splits the output per case and reports the first failing case index.
- **Submission verdict:** a CE anywhere stops judging. Otherwise the first non-AC file in order (sample → small → large) decides. A missing or null `time` is **never** treated as 0.
- **What users see:** verdict, file kind, case number, max time and memory. **Inputs are shown only for sample cases**, otherwise players could hard-code hidden answers. Compile output is trimmed to 2 KB.

### 14.6 Quota management (target ≈ ₹0)

1. **Packing + staging + fail fast** (§14.2–14.3).
2. **Verdict cache:** `judge:cache:{problemVersion}:{codeHash}`, 7 days, with a fallback lookup in the DB index. Identical resubmissions cost 0 calls.
3. **Gates before spending quota:** 1 submit per 5 s, at most 15 per match per user, the code must change, and Run uses only the sample file.
4. **Budget counter:** Redis `judge0:budget:{date}` (mirrored in `judge_budget_daily`). Limit = `JUDGE0_DAILY_BUDGET`. A BullMQ `limiter` matches the plan's rate.
5. **Admission control:** `/internal/capacity` returns `{remaining, breaker}`. battle-service refuses new matches when `remaining < MATCH_RESERVE_CALLS` (default 40) or the breaker is open.
6. **Degradation ladder**, as the budget falls below 30%, 15% and 5%:
   1. disable custom-input Run;
   2. Run = samples only, once per minute;
   3. no new matches; "Judge at capacity" banner.
7. **Testing never uses real quota.** Local dev, CI and k6 all use `apps/fake-judge0`. A nightly contract test uses about 10 real calls.
8. **Policy:** never create multiple free accounts or rotate keys to get around quotas (that breaks the terms of service). For demo days, take a paid plan for one month.

### 14.7 Time-limit calibration (Kattis/Polygon-style, run through Judge0)

- **Publishing requires:**
  - ≥1 AC reference solution (C++ required; Java and Python recommended);
  - ≥1 must-TLE solution (e.g. brute force).
- The `problem-calibrate` job runs each reference solution on each file through Judge0. This costs about 6–12 calls, once per problem version.
- Per file and language:
  - `cpu_limit = clamp(ceil(3 × slowestAC_ms), 1000, instanceMax)` when the language has an AC reference.
  - Otherwise `ceil(3 × slowestAC_cpp × factor)`.
  - The 3× margin is wider than the 2–2.5× used on dedicated hardware, because hosted Judge0 hardware is shared and noisy.
- **Publishing fails if:**
  - a must-TLE solution passes within `2 × limit` (Kattis-style safety margin), or
  - any AC reference solution runs above `limit / 1.5`.
- On publish: `version++`, which invalidates verdict caches and triggers `problem.published.v1`.

### 14.8 Drift tracking

- A weekly `judge-drift-check` runs fixed benchmark programs (C++ and Python), about 2–4 calls.
- It compares the times with the baseline median.
- If drift exceeds ±20%, it sets a global `drift_factor` (capped between 0.5 and 2.0) that multiplies every limit. This is the same idea as Codeforces doubling time limits after a hardware change.
- The factor is exposed as a metric and on the admin page.

### 14.9 Rejudge

- When a problem's tests change, `version` is bumped and an admin can enqueue a `rejudge` of affected submissions. That's practice and audit only.
- **Completed matches are not reversed by default.** If an admin chooses to reverse one, it's done with compensating ledger entries (`reason='rejudge_reversal'`), which are idempotent through the ledger's unique key.

### 14.10 `CodeExecutor` interface (to swap in a self-hosted judge later)

```ts
interface CodeExecutor {
  submitBatch(runs: ExecRequest[]): Promise<{ runId: string; token: string }[]>;
  fetchBatch(tokens: string[]): Promise<ExecResult[]>;
  info(): Promise<{
    maxCpuSec: number;
    maxMemKb: number;
    maxFileKb: number;
    maxBatch: number;
    languages: LangInfo[];
  }>;
}
// Implementations: Judge0HttpExecutor (RapidAPI header mode | X-Auth-Token mode | none), FakeJudge0 (via apps/fake-judge0)
```

---

## 15. Coins, levels, leaderboard (rating-service)

- **Rules** (pure functions in `packages/domain/scoring`, matching v1 exactly):
  - Win: +50. Loss: −50, floored at 0. Timeout: both −50, floored at 0. Forfeit: leaver −50, opponent +50.
  - Level: `coins < 500 → 1; < 900 → 2; < 1000 → 3; else 4`.
- **Applying a completed match** (one transaction per user, or one transaction for both):
  ```sql
  -- lock row & compute
  SELECT coins FROM player_stats WHERE user_id = $u FOR UPDATE;
  -- applied = max(coins + delta, 0) - coins
  INSERT INTO coin_ledger (id, user_id, match_id, reason, delta, applied, balance_after)
  VALUES (...) ON CONFLICT (match_id, user_id, reason) DO NOTHING RETURNING id;
  -- only if a row was inserted:
  UPDATE player_stats SET coins = $new, level = $lvl, wins = wins + $w, losses = losses + $l, draws = draws + $d,
         version = version + 1, updated_at = now() WHERE user_id = $u;
  -- outbox rating.stats.changed.v1
  ```
- **Leaderboard:**
  - Redis ZSET `lb:coins`, member = userId, score = `coins * 1e10 + (1e10 - lastUpdateEpochSec)`, so ties are broken by who got there first. Updated after commit.
  - Top 50 via `ZREVRANGE`; my rank via `ZREVRANK` + 1, which is O(log N).
  - Profiles for the top 50 come from user-service `GET /users/batch`, cached for 30 s.
  - Friends leaderboard: `ZMSCORE` over the friend IDs, then sorted in the app.
  - **Fallback when Redis is down:** use the `player_stats_leaderboard` index (top 50 is fast). Rank = `COUNT(*) WHERE coins > my_coins AND is_admin = false`, which is an index range count, cached locally for 30 s.
  - **Rebuild** on boot and daily: build `lb:coins:tmp` from Postgres, then `RENAME` it over `lb:coins` (atomic swap).
- **Match history in the profile:** battle `GET /matches/history` (opponent, result, date) joined in the BFF with ledger deltas (the real coin change, which fixes v1 bug #21).
- **Optional later phase:** Glicko-2 rating for a "ranked" mode. Coins stay as they are.

---

## 16. Auth and security

- **Passwords:** Argon2id (`m=19456 KiB, t=2, p=1`, per OWASP). Migrated bcrypt hashes are verified with bcrypt and **rehashed with Argon2id on successful login**.
- **Access token:** EdDSA (Ed25519) JWT, **15 min**. Claims `sub, role, ev (email verified), iat, exp, kid`. Kept in an httpOnly Secure SameSite=Lax cookie `cb_at` scoped to the web origin (it travels through the Next rewrite). Services verify it with **JWKS**, so no DB call is needed. Keys are rotated with `kid`.
- **Refresh token:** an opaque 256-bit random value, stored hashed. **30 days**, rotated on every use. Cookie `cb_rt` has `Path=/api/v1/auth` (refresh **and** logout need it).
  - **Reuse detection:** if a token that was already rotated is used again, revoke the whole `family_id` and force a re-login.
  - **Multi-tab race:** a rotated token presented again within **10 s** returns `409 CONFLICT` (retry with the new cookie) instead of revoking the family. No tokens are issued on that path, so a thief gains nothing.
- **CSRF:**
  - SameSite=Lax + a custom header `x-cb-csrf: 1` required on mutations (a simple request can't set it).
  - `Origin` check in the gateway.
- **RBAC:**
  - `user`: play.
  - `problem_setter`: problem authoring.
  - `admin`: everything, plus role management.
  - Enforced in the gateway route table **and** in each service.
- **Login protection:**
  - Rate limits: 5 per minute per IP+email, 20 per minute per IP.
  - After 10 failures: `locked_until = now()+15m`.
  - The same error message is returned for "no such user" and "wrong password".
- **Input:** zod everywhere. Body limits as in §7.3. Usernames match `^[a-zA-Z0-9_]{3,20}$`.
- **Uploads:**
  - Signed direct-to-Cloudinary upload with an allowed format list (jpg/png/webp), max 2 MB and a transform to 256×256.
  - The server only accepts `avatarUrl` values under our Cloudinary folder.
- **Headers:** helmet (CSP for web: `default-src 'self'`, `connect-src` api/rt origins). HSTS through Caddy.
- **Judge callbacks:** HMAC-signed URL + token match. The callback route is excluded from JWT auth but rate-limited.
- **Secrets:** `.env` only on the VM (chmod 600), never committed. GitHub Actions secrets for CI. Generate Ed25519 keys with `scripts/gen-keys.ts`.
- **Auditing:** coin ledger, role changes (`identity.user.role_changed.v1`), admin actions logged with the actor.
- **AI-specific security:** see §22.5.

---

## 17. Caching, rate limiting, performance

### 17.1 Caching

| Data                               | Strategy                            | TTL / invalidation                 |
| ---------------------------------- | ----------------------------------- | ---------------------------------- |
| Problem public view                | Next ISR + Redis cache-aside        | Invalidate on `problem.updated.v1` |
| Judge spec + test files            | Local LRU (keyed by sha256) + Redis | Immutable per version              |
| Profiles batch (leaderboard)       | Redis                               | 30 s                               |
| Friend sets (presence fan-out)     | Redis SET                           | Invalidate on friendship event     |
| Match participation (judge intake) | Redis                               | Until `ends_at`                    |
| JWKS                               | In-memory                           | 10 min, refetch on unknown `kid`   |

- **Single-flight** (coalesce concurrent misses for the same key) and **jittered TTLs** (±10%) prevent cache stampedes.
- **L1 in-process LRU** (≤ 5 s) in front of Redis for hot keys. It also protects the DB if Redis is down.

### 17.2 Rate limiting (gateway, Redis Lua token bucket; in-memory fallback)

| Route                          | Limit                                          |
| ------------------------------ | ---------------------------------------------- |
| Global per IP                  | 300/min                                        |
| Auth login / register / forgot | 5/min per IP+identifier, 20/min per IP         |
| `POST /challenges`             | 10/min per user                                |
| `POST /submissions` (submit)   | 1 per 5 s per user per match; max 15 per match |
| `POST /submissions` (run)      | 6/min per user                                 |
| AI endpoints                   | Per-user daily token quota (§22)               |
| Search                         | 60/min per user                                |

Responses include `RateLimit-*` headers; a 429 includes `Retry-After`.

### 17.3 Performance rules

- No N+1 queries. Use batch endpoints (`/users/batch`, `/presence/query`) and Redis pipelines.
- Cursor pagination everywhere. Indexes as defined in §9. Run `EXPLAIN ANALYZE` on every new query in its PR.
- **PgBouncer** (transaction pooling) is optional on the single VM. Without it, keep pool sizes small: about 5 per service process.
- Compression: Caddy gzip/zstd.

### 17.4 Capacity estimate (for interviews; not the demo)

Assume 100k DAU, 10k concurrent sockets, 2k concurrent matches, about 6 submits per user per match, and 30-minute matches.

- **Submissions:** 2000 × 2 × 6 / 1800 s ≈ **13/s average, about 50/s peak**.
- **Judge0 calls:** ≈ 3 × submissions → **40–150/s at peak**. That would need a self-hosted judge or an enterprise plan, which is exactly why `CodeExecutor` is an interface.
- **Realtime:** 10k sockets fit on 2–3 nodes. Presence pings: 10k / 25 s = **400 Redis writes/s**, which is trivial.
- **Kafka:** under 1k events/s. 2 partitions per topic is enough at demo scale; increase for scale.

---

## 18. Failure modes and fallbacks

**Principle:** Redis, Kafka, Judge0 and the AI provider may fail without corrupting data. **Postgres is the source of truth.**

### 18.1 Redis

**Client settings:**

- Cache, rate-limit and presence clients: `enableOfflineQueue:false`, `commandTimeout:150ms`, wrapped in a circuit breaker (after 5 failures, skip Redis for 10 s).
- BullMQ clients: `maxRetriesPerRequest:null`.

| Role                  | When Redis is down                                                                                                                                                                                                                                                                                                | When it recovers                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Cache                 | Read Postgres; L1 LRU absorbs bursts                                                                                                                                                                                                                                                                              | Warms up naturally                                                                   |
| Rate limit            | In-memory token bucket per instance (limit ÷ instances). Login is stricter.                                                                                                                                                                                                                                       | Automatic                                                                            |
| Idempotency fast path | Postgres `idempotency_keys` is authoritative                                                                                                                                                                                                                                                                      | —                                                                                    |
| Auth                  | Unaffected: JWT + JWKS; refresh tokens are in Postgres. Socket tickets skip the single-use check.                                                                                                                                                                                                                 | —                                                                                    |
| Leaderboard           | Postgres index fallback (§15)                                                                                                                                                                                                                                                                                     | `leaderboard-rebuild`                                                                |
| Presence              | UI shows "presence unavailable"; challenges still work via REST (the online check is skipped)                                                                                                                                                                                                                     | Self-heals through 25 s pings                                                        |
| Realtime delivery     | **Unaffected:** delivery is Kafka → per-node local emit (§13.2)                                                                                                                                                                                                                                                   | —                                                                                    |
| BullMQ                | Intent is durable in Postgres (`submissions.status='queued'`, `job_outbox`, `matches.ends_at`). **Timeouts still fire** through the Postgres-leader reconciler. **Judging degrades** to judge workers polling `submissions WHERE status='queued' FOR UPDATE SKIP LOCKED`, with Postgres acting as a backup queue. | The job-outbox dispatcher re-enqueues with the same `jobId`; duplicates are harmless |

**Production profile:** split into three Redis instances (queue: `noeviction` + AOF everysec; cache: `allkeys-lru`, no persistence; realtime/presence: ephemeral), each with a replica and Sentinel or managed failover.

**Demo profile:** one Redis with `noeviction` (required by BullMQ). Every cache key **must have a TTL**, and `maxmemory` is sized to 512 MB. This is a known single point of failure for the demo and is mitigated by the fallbacks above.

### 18.2 Kafka

- If it is down, outbox rows accumulate and are published on recovery. **No events are lost; they're delayed.**
- Realtime pushes pause; clients resync over REST on focus or reconnect, and every 30 s while on a battle page.
- Production: 3 brokers, RF=3, `min.insync.replicas=2`, idempotent producer, `acks=all`.

### 18.3 Postgres

This is the real single point of truth.

- **Demo:** nightly `pg_dump` of each DB to R2 (free), with a tested restore script.
- **Production:** primary + synchronous standby (Patroni or managed), point-in-time recovery.
- Services expose readiness = DB reachable, so the gateway returns 503 quickly instead of hanging.

### 18.4 Judge0

Circuit breaker, queued submissions, admission control, the deciding cap and abort without coin change (§14.4, §11.4).

### 18.5 AI provider

Feature flags. Fallback to a cheaper model, then to "AI unavailable". Never in the critical path of a match.

### 18.6 Chaos drills (Phase 6; good interview demos)

1. `docker stop redis` mid-match → the match continues (timer, forfeit, Postgres-mode judging) → start Redis again → leaderboard and presence rebuild themselves.
2. Kill a realtime node → clients reconnect to another node and resync.
3. `docker stop redpanda` → actions still succeed; pushes are delayed and arrive after restart.
4. Make fake-judge0 return 500s → breaker opens, new matches are refused, a running match goes to `deciding` and then resolves or aborts.

---

## 19. Observability

- **Logs:** pino JSON with `service, env, requestId, traceId, userId?, matchId?`. No PII: emails are hashed. Shipped by the OTel Collector to Grafana Cloud Loki.
- **Traces:** OpenTelemetry auto-instrumentation (http, fastify, pg, ioredis) + manual spans. **Context is propagated** through HTTP `traceparent`, Kafka headers and BullMQ job data, so one trace covers **submit → judge → verdict → match end → socket push**.
- **Metrics (Prometheus naming):**
  - `http_server_duration_seconds`
  - `judge_queue_depth`, `judge_latency_seconds{stage}`, `judge0_calls_total{result}`, `judge0_budget_remaining`
  - `match_start_latency_seconds`, `matches_active`
  - `socket_connections`, `presence_online_users`
  - `kafka_consumer_lag{group}`, `outbox_unpublished`, `dead_letters_total`
  - `ai_tokens_total{feature,model}`, `ai_cost_usd_total`
- **SLOs (demo targets):** match start p95 < 1.5 s; judge stage-1 p95 < 6 s (hosted Judge0); API p95 < 200 ms (excluding judge and AI).
- **Errors:** Sentry for web and services, with release tagging.
- **Health:**
  - `/health/live` (process up).
  - `/health/ready` (DB + critical dependencies). Redis is **not** critical for most services; Kafka is not critical for the API.

---

## 20. Testing strategy

| Layer          | Tooling                                                 | What                                                                                                                                               |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit           | Vitest                                                  | `domain/*`: state machines, scoring, verdict classification, checkers (100% branch coverage target)                                                |
| Integration    | Vitest + **Testcontainers** (Postgres, Redis, Redpanda) | Repositories, transactions, outbox/inbox, consumers, BullMQ processors                                                                             |
| **Race tests** | Vitest + `Promise.all`                                  | Every row in the §12 matrix                                                                                                                        |
| Contract       | zod schemas in `contracts`                              | Producers validate before publishing; consumers validate on receive; HTTP schemas generate OpenAPI (`/docs`)                                       |
| Judge          | `apps/fake-judge0`                                      | Scripted verdicts and latencies (e.g. the code contains `// @fake verdict=TLE time=2.3 delay=4000`), callback and polling modes, 429/500 injection |
| E2E            | Playwright                                              | Register → verify (fake email inbox) → friend → challenge → accept → submit → win → leaderboard                                                    |
| Load           | **k6** (HTTP + `k6/ws`)                                 | 2k sockets + 200 concurrent matches on the demo VM against fake-judge0. Record p95s for the README.                                                |
| Chaos          | Scripts in `infra/chaos/`                               | §18.6                                                                                                                                              |
| Nightly        | GitHub Action                                           | Real Judge0 contract test (about 10 calls)                                                                                                         |

**CI gates:** lint, typecheck, unit, integration (only affected packages via `turbo --filter=...[origin/main]`), build. E2E runs on main.

---

## 21. Frontend (Next.js) plan

### 21.1 Stack

- Next.js App Router on **Vercel Hobby**.
- TanStack Query (server state), **Zustand** (UI/socket state; **Redux is removed**).
- Tailwind + **shadcn/ui** (`packages/ui`), Framer Motion, Recharts.
- **CodeMirror 6** (`@uiw/react-codemirror`, already used in v1). Chosen over Monaco: about 300 KB vs about 2–3 MB, and better on mobile.
- `next/font`; `next/image` with a Cloudinary loader.

### 21.2 Routes and rendering

| Route                                                                         | Rendering                                                            | v1 component                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/` landing                                                                   | SSG                                                                  | HomePage + TypingEffect                                                     |
| `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password` | Static + client forms                                                | Login, EmailVerification, PasswordReset                                     |
| `/lobby`                                                                      | SSR (BFF lobby) + live presence                                      | MainSection, Matching/Match, ActiveContests banner                          |
| `/friends`                                                                    | SSR + Query                                                          | Friends, FriendRequest                                                      |
| `/leaderboard`                                                                | **ISR 30 s** + client "my rank" + presence dots                      | LeaderBoard                                                                 |
| `/u/[username]`                                                               | **ISR + on-demand revalidate** (webhook on `match.completed`)        | Profile (Header, Stats, PerformanceGraph, ContestHistory)                   |
| `/battle/[matchId]`                                                           | **Client-only** island (editor loaded with `dynamic()`, `ssr:false`) | Problem, CodeEditor, LanguageSelector, Timer, Navbar                        |
| `/notifications`                                                              | SSR + Query                                                          | NotificationPanel                                                           |
| `/admin/problems`, `/admin/problems/new`, `/admin/problems/[id]`              | SSR, admin-gated                                                     | AddQuestion (expanded: test files, reference solutions, calibrate, publish) |
| `/practice/[slug]` (later)                                                    | ISR                                                                  | —                                                                           |

### 21.3 API topology

- `next.config` rewrites `/api/:path*` → `https://api.<domain>/api/:path*`. This keeps requests same-origin, avoids CORS and keeps cookies first-party.
- Server Components fetch the gateway directly, forwarding the cookie.
- Sockets connect directly to `wss://rt.<domain>` with the ticket (§13.1).
- `middleware.ts` is only an optimistic guard (cookie present → allow; else redirect to `/login`). Real authorization happens at the gateway.

### 21.4 Performance and correctness

- **Server clock sync:** NTP-style. Use the `serverNow` from the state/started payload and a ping round-trip → `offset`. Timer = `endsAt - (Date.now() + offset)`. This is drift-free and immune to client clock changes.
- **Editor draft autosave** per `matchId` and language to IndexedDB (`idb-keyval`), restored on reload.
- **Socket provider:** a singleton with typed events. On event: `queryClient.setQueryData` (no refetch storms). Dedupe by `eventId`. Resync on a `seq` gap or on `visibilitychange`.
- **Idempotency keys generated on the client** (`crypto.randomUUID()`) for every mutation, reused on retry.
- **Prefetch** the battle route chunk and the editor when `challenge:updated{accepted}` arrives.
- Virtualised lists (`@tanstack/react-virtual`) for leaderboard, history and notifications. Infinite scroll uses cursors.
- **Budgets:** First Load JS ≤ 170 KB on non-battle routes; Lighthouse CI targets LCP < 2.5 s, INP < 200 ms, CLS < 0.1; `@next/bundle-analyzer` + `size-limit` in CI.
- **Security:** no tokens in localStorage; CSP; the editor never runs user code in the browser.

### 21.5 UI/UX improvements

- **Design system:** dark-first tokens, shadcn components, Storybook, Playwright visual snapshots.
- **Battle room:**
  - Resizable panels (`react-resizable-panels`): problem | editor | console/results.
  - Language switch keeps a draft per language.
  - `Ctrl+Enter` submits, `Ctrl+'` runs.
  - The timer turns amber at 5 min and red at 1 min.
  - **Live opponent activity** ("Opponent submitted… WA").
  - Results panel per stage and file, with the failing case number.
- **Match moments:**
  - Challenge modal with a countdown ring (30 s).
  - "Preparing match…" → 3-2-1 intro.
  - Victory/defeat screen with an animated coin delta and level-up.
  - AI coach review streams in below (§22).
- **Lobby:** online friends first, then other online users (paginated). Challenge buttons are disabled for users who are `in_match`. "Rejoin match" banner.
- **Profile:** coins/level card, win/loss/draw donut, performance line chart (coins over time from ledger history), activity heatmap, history with cursor pagination.
- **Notification centre** with an unread badge; toasts only for transient actions.
- **Responsive:** everything except the battle editor is fully usable on mobile. On mobile, battle shows "best on desktop" but still works.
- **Accessibility:** Radix primitives, focus management, `prefers-reduced-motion`, keyboard navigation, colour contrast AA.

---

## 22. AI integration plan

### 22.1 Principles

- AI is **never in the critical path** of a match (judging and winner decisions don't use it).
- **Cost ≈ ₹0 by default:**
  - `AI_ENABLED=false` unless `ANTHROPIC_API_KEY` is set.
  - A hard daily spend cap (`AI_DAILY_BUDGET_USD`, default 0.50) and per-user quotas.
  - Cheap model by default; aggressive caching.
- **Embeddings are free:** a local **transformers.js** model (`bge-small-en-v1.5` or `all-MiniLM-L6-v2`, 384-dim) runs on the VM's CPU. Stored in **pgvector**.

### 22.2 Features (in priority order)

| #   | Feature                                                      | Trigger                                                                                          | Design                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **AI post-match coach**                                      | `battle.match.completed.v1` → `ai-review` job (only if both opted in, or the viewer requests it) | Input: problem, both final codes, verdicts. Output (zod-structured): complexity, bugs, cleaner approach, comparison with opponent, 3 tips. Cached by `(problemId, codeHashA, codeHashB)`. Streamed to `/u/...` and the end screen. Model: `claude-haiku-5-5`; `claude-sonnet-5-5` only when explicitly requested.                       |
| 2   | **Progressive hints** (practice; in battles they cost coins) | `POST /ai/hints {problemId, level 1..3}` (SSE)                                                   | RAG over statement + editorial + the user's code. **Leak guard:** a second cheap call ("does this reveal a full solution? yes/no") blocks full solutions; regenerate or refuse. Hints in battles cost 10/20/30 coins through the **idempotent ledger** (`reason='hint_purchase'`, unique per match, user and level).                    |
| 3   | **RAG tutor** ("why WA?", "explain prefix sums")             | `POST /ai/tutor` (SSE)                                                                           | Corpus: problems, editorials, curated DSA notes (markdown in repo `content/dsa/`). Heading-aware chunking (≈500 tokens, 15% overlap). **Hybrid retrieval:** Postgres FTS (`tsvector`) + pgvector cosine, fused with RRF (k=60), top 8 → answer with citations.                                                                          |
| 4   | **Recommendations and balanced problem selection**           | `GET /ai/recommendations`                                                                        | Problem embeddings + a user weakness vector (tags from WA/TLE verdicts). Recommend practice problems. Optional: battle selection prefers problems near both players' weak and strong tags.                                                                                                                                              |
| 5   | **Agentic problem-generation pipeline** (admin)              | `POST /ai/problems/generate {topic, difficulty}` → `ai-generate` job                             | LangGraph: draft statement → reference solution → brute force → test generator → **run both through Judge0 as tools** (counts against the budget) → cross-check → pack test files → **dedupe** against existing problems (embedding similarity > 0.9 → reject) → save as a **draft** for human review → normal calibration and publish. |
| 6   | **Anti-cheat signals**                                       | After each match                                                                                 | Plagiarism: tokenise + normalise identifiers → k-gram winnowing fingerprints (MOSS-style) compared with the opponent and recent submissions for the same problem. Client telemetry: paste bursts, tab blur. An LLM classifier is **one signal only**; the output is a **flag for review**, never an automatic penalty.                  |
| 7   | **Bot opponent** (later)                                     | "Play vs bot"                                                                                    | Solve time sampled from a distribution conditioned on difficulty and the player's level; uses a stored AC solution. No LLM call at runtime.                                                                                                                                                                                             |

### 22.3 Architecture of ai-service

- Fastify API (SSE streaming) + BullMQ worker. LangChain.js for prompts, structured output and retrievers; **LangGraph.js** for the generation agent.
- **Provider abstraction** (`ModelGateway`): primary model → fallback model → error. Timeouts, retries, token counting, cost accounting per call (`ai_requests`).
- **Prompts are versioned in the repo** (`apps/ai-service/prompts/*.md`, with front-matter `version`). The prompt version is stored with every response.
- **Prompt caching** for large static context (problem statement + editorial).
- **Evals:**
  - `apps/ai-service/evals/` golden sets (hint leakage, review accuracy, RAG answer faithfulness).
  - LLM-as-judge scoring.
  - Run on demand and on prompt changes (a CI job with a small budget).
- **Observability:** OTel spans + the `ai_requests` table (feature, model, tokens in/out, cost, latency, cache hit). Langfuse Cloud is optional if its free tier fits (verify).

### 22.4 Budget enforcement

- Redis `ai:spend:{date}` (USD × 1e6, integer) is checked before each call. If over the limit, the feature returns `503 AI_BUDGET_EXHAUSTED`.
- Per-user daily token quota, e.g. 20k tokens for hints and tutor.
- Review generation is opt-in, so it doesn't run after every match.

### 22.5 AI security

- **Prompt injection:** user code and messages are untrusted.
  - Wrap them in delimited data blocks (`<user_code>…</user_code>`).
  - The system prompt says to never follow instructions found inside the data.
  - Outputs are validated with zod.
  - Tools are allow-listed (the generator may only call `runJudge0` and `searchProblems`).
- **No PII** in prompts: usernames are replaced by "Player A/B".
- Hidden test cases are never placed in prompts that produce user-visible output.

### 22.6 ai_db

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE documents (id uuid PRIMARY KEY, source text NOT NULL, ref_id text, title text, version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE chunks (
  id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal int NOT NULL, content text NOT NULL, tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding vector(384) NOT NULL
);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);
CREATE INDEX chunks_embedding ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE TABLE problem_vectors (problem_id uuid PRIMARY KEY, embedding vector(384) NOT NULL, tags text[] NOT NULL);
CREATE TABLE ai_requests (id uuid PRIMARY KEY, user_id uuid, feature text NOT NULL, model text NOT NULL, prompt_version text NOT NULL,
  input_tokens int, output_tokens int, cost_micro_usd bigint, latency_ms int, cache_hit boolean, status text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ai_reviews (cache_key text PRIMARY KEY, match_id uuid, content jsonb NOT NULL, prompt_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE hint_usage (user_id uuid, problem_id uuid, match_id uuid, level smallint, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, problem_id, level));
```

---

## 23. Deployment (₹0 demo profile)

### 23.1 Target topology (free tiers; verified 2026-11-08, re-verify per §28)

| Component       | Where                                                                                                                     | Notes                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (Next.js)   | **Vercel Hobby**                                                                                                          | Non-commercial use only. Rewrites `/api/*` to the API domain.                                                                                                                                                               |
| Everything else | **One Oracle Cloud Always Free Ampere A1 VM** (now **2 OCPU / 12 GB**, cut from 4/24 in Aug 2026), Ubuntu, docker compose | ARM64 images. Oracle may reclaim idle Always Free instances, so keep backups (§18.3). If there's no A1 capacity in your region, retry or pick another home region at signup.                                                |
| Postgres        | **On the VM** (one container, 8 logical DBs)                                                                              | Neon free (100 projects × 1 GB, 100 CU-h/project/month) is the alternative. **Caveat:** our pollers (outbox sweeper, reconciler) keep Neon compute awake and would use up CU-hours, so self-hosting on the VM is preferred. |
| Redis           | On the VM                                                                                                                 | **Not Upstash.** Its free tier is 500K commands/month, which BullMQ and presence would exhaust in days.                                                                                                                     |
| Kafka           | **Redpanda on the VM** (`--smp 1 --memory 1G`)                                                                            | Aiven free Kafka (5 topics × 2 partitions, 250 KiB/s, powers off when idle, no SLA) is the fallback; our topic plan fits within it.                                                                                         |
| Judge0          | **Hosted API** (RapidAPI Basic free, or a judge0.com plan for demo days)                                                  | §14                                                                                                                                                                                                                         |
| Blobs           | Cloudinary free (avatars), Cloudflare R2 free tier (test files, backups)                                                  | —                                                                                                                                                                                                                           |
| Email           | Resend or Brevo free tier (verify limits)                                                                                 | —                                                                                                                                                                                                                           |
| DNS / TLS       | Free **DuckDNS** subdomain + **Caddy** (automatic Let's Encrypt). Or a cheap domain (~₹800/yr) on Cloudflare.             | Subdomains: `api.`, `rt.`                                                                                                                                                                                                   |
| Observability   | Grafana Cloud free + Sentry free                                                                                          | —                                                                                                                                                                                                                           |
| CI/CD           | GitHub Actions + GHCR                                                                                                     | —                                                                                                                                                                                                                           |

### 23.2 VM memory budget (12 GB)

| Process                                                                                           | Approx. RAM                |
| ------------------------------------------------------------------------------------------------- | -------------------------- |
| Postgres (`shared_buffers=512MB`)                                                                 | 1.5 GB                     |
| Redpanda                                                                                          | 1.2 GB                     |
| Redis (`maxmemory 512mb`)                                                                         | 0.6 GB                     |
| 9 Node services (API) + 5 workers + realtime + gateway (~150 MB each, `--max-old-space-size=192`) | 2.5 GB                     |
| ai-service with local embedding model                                                             | 0.8 GB                     |
| Caddy, OTel Collector, misc                                                                       | 0.5 GB                     |
| **Total**                                                                                         | **≈ 7 GB (5 GB headroom)** |

### 23.3 docker-compose.prod.yml services

`caddy, gateway, realtime, identity, user, battle-api, battle-worker, problem-api, problem-worker, judge-api, judge-worker, rating, notification, ai-api, ai-worker, postgres, redis, redpanda, otel-collector`, plus one-off `migrate-*` containers.

### 23.4 Build and deploy

1. GitHub Actions: lint, typecheck, test → `turbo prune --docker <app>` → multi-stage Dockerfile (pnpm fetch, build, `node:22-slim` runtime, non-root) → `docker buildx --platform linux/arm64` → push to GHCR (tag = git SHA).
2. Deploy job: SSH to the VM → `docker compose pull` → run `migrate-*` (drizzle-kit migrate) → `docker compose up -d` → smoke test `/health/ready` → roll back to the previous tag on failure.
3. **Migrations follow expand/contract:** add a column → deploy code that writes both → backfill → switch reads → drop the old column in a later release.
4. Vercel deploys `apps/web` automatically (root dir `apps/web`, Turbo-aware build). `turbo-ignore` skips builds when web hasn't changed.

### 23.5 Environment variables

**Common (all services):**
`NODE_ENV, SERVICE_NAME, PORT, LOG_LEVEL, DATABASE_URL, REDIS_URL, KAFKA_BROKERS, KAFKA_SASL_USERNAME?, KAFKA_SASL_PASSWORD?, KAFKA_SSL?, JWKS_URL, INTERNAL_SERVICE_SECRET, OTEL_EXPORTER_OTLP_ENDPOINT, SENTRY_DSN?`

| Service      | Additional                                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gateway      | `CORS_ORIGINS, TRUSTED_PROXIES, RATE_LIMIT_PER_IP_PER_MIN, SERVICE_URL_*` (identity, user, battle, problem, judge, rating, notification, ai, realtime)                                                                                                           |
| identity     | `JWT_PRIVATE_KEY_PEM, JWT_KID, ACCESS_TOKEN_TTL=900, REFRESH_TOKEN_TTL=2592000, SOCKET_TICKET_TTL=60, APP_URL, REALTIME_PUBLIC_URL`                                                                                                                              |
| user         | `CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_FOLDER`                                                                                                                                                                            |
| battle       | `MATCH_DURATION_SECONDS=1800, CHALLENGE_TTL_SECONDS=30, DECIDE_CAP_SECONDS=600, MATCH_RESERVE_CALLS=40, RECONCILER_INTERVAL_MS=15000, PROBLEM_SERVICE_URL, JUDGE_SERVICE_URL`                                                                                    |
| problem      | `R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, JUDGE_SERVICE_URL`                                                                                                                                                                            |
| judge        | `JUDGE0_BASE_URL, JUDGE0_AUTH_MODE=rapidapi\|token\|none, JUDGE0_API_KEY, JUDGE0_RAPIDAPI_HOST, JUDGE0_MODE=callback\|poll, JUDGE0_CALLBACK_BASE_URL, JUDGE0_CALLBACK_SECRET, JUDGE0_DAILY_BUDGET, JUDGE0_RATE_PER_SEC, PROBLEM_SERVICE_URL, BATTLE_SERVICE_URL` |
| rating       | `USER_SERVICE_URL`                                                                                                                                                                                                                                               |
| notification | `EMAIL_PROVIDER=resend\|brevo\|sendgrid, EMAIL_API_KEY, EMAIL_FROM, APP_URL`                                                                                                                                                                                     |
| realtime     | `NODE_ID, KAFKA_GROUP_PREFIX=realtime`                                                                                                                                                                                                                           |
| ai           | `AI_ENABLED, ANTHROPIC_API_KEY, AI_MODEL_DEFAULT=claude-haiku-5-5, AI_MODEL_STRONG=claude-sonnet-5-5, AI_DAILY_BUDGET_USD=0.5, EMBEDDING_MODEL=Xenova/bge-small-en-v1.5`                                                                                         |
| web          | `API_ORIGIN, NEXT_PUBLIC_REALTIME_URL, REVALIDATE_SECRET`                                                                                                                                                                                                        |

Every app validates its env with zod in `src/config/env.ts` and exits if anything is invalid. Keep a `.env.example` per app.

### 23.6 Optional showcase (not live)

- `infra/k8s`: Helm charts, HPA for API services, **KEDA** ScaledObjects (judge-worker on BullMQ queue depth, realtime on connections), PodDisruptionBudgets.
- Run once on cloud trial credits for screenshots and k6 results, then tear it down.

---

## 24. Data migration v1 (MongoDB) → v2 (Postgres)

Script: `scripts/migrate-v1/` (TS). It is **idempotent** (upserts on `legacy_mongo_id`), supports `--dry-run`, and prints count and checksum reports.

1. **ID mapping:** generate a UUIDv7 for each Mongo `_id`. Store the mapping in a `legacy_id_map` table in the migration DB.
2. **Users** →
   - `identity.credentials`: `password_algo='bcrypt'`; `email_verified_at = createdAt if isVerified`; `role = admin if isAdmin`.
   - `user.profiles`: username, fullname, avatar.
   - `rating.player_stats`: coins, level, `is_admin`.
   - `coin_ledger`: one row with `reason='migration'` and `delta=coins`.
3. **Friends** → canonical pairs. When duplicates conflict, precedence is `accepted > pending > ignored`, and `requested_by` comes from the requester.
4. **Questions** →
   - `problems`: map fields; `status='published'`; `slug` from the title; `examples` → jsonb.
   - `testCases` → test files: index 1 was the "large" case in v1 (TLE was only checked there), so it becomes `large`. Everything else goes into the `small` pack (one case per line block). Examples become `sample`.
   - `executionTimes` → initial `problem_language_limits` (ms). **Then recalibrate** once reference solutions are added.
5. **Contests** →
   - `status=completed` → `battle.matches` (`end_reason='legacy'`, winner mapped, `started_at`/`ended_at` from `startTime`/`endTime`) + `match_participants` (result: winner → win/loss; null winner → draw).
   - `status=active` → **skip** (cut over while the system is idle).
6. `problem.user_problem_seen` from all contests (both users × `problemId`).
7. **Verify:** user counts, coin sums, friendship counts, and match counts per user are equal before and after.
8. **Cutover:**
   - announce a maintenance window;
   - put v1 in read-only mode;
   - run the final migration;
   - switch DNS and Vercel to v2;
   - keep v1 backups for 30 days.

---

## 25. Roadmap (phases, tasks, Definition of Done)

> Work top to bottom. Each phase must pass its Definition of Done (DoD) before the next one starts, except the frontend tracks, which run in parallel as noted.

### Phase 0: Foundation (≈1 week)

- [ ] Create the monorepo at the repo root: `pnpm-workspace.yaml`, `turbo.json` (tasks: build, dev, worker, lint, check-types, test, test:int), `tsconfig.base.json`, `packages/config/*` (tsconfig, eslint flat config with `boundaries`, prettier, tailwind).
- [ ] `packages/contracts` skeleton: envelope, error codes, socket maps.
- [ ] `libs`: logger, errors, env, ids, http-server (health, error mapper, graceful shutdown, OTel), db (drizzle factory, tx helper, advisory lock), redis (role options, breaker), events (outbox relay, consumer with inbox + DLQ), queue (BullMQ factory, job-outbox dispatcher), idempotency, rate-limit, http-client, testing.
- [ ] `infra/docker-compose.yml`: postgres (+ `init.sql` creating 8 DBs and roles), redis (noeviction), redpanda + console, otel-collector, fake-judge0.
- [ ] `apps/fake-judge0` (Fastify): `/config_info`, `/languages`, `POST /submissions/batch`, `GET /submissions/batch`, callbacks, scripted verdicts.
- [ ] One "hello" service using every lib, as a template (`scripts/new-service.ts` copies it).
- [ ] GitHub Actions CI (lint, typecheck, unit, integration with Testcontainers).
- [ ] `docs/adr/` with ADR-001 … ADR-012 (§26).

**DoD:**

- `pnpm i && docker compose up -d && pnpm dev` runs the template service.
- `/health/ready` is green.
- A trace shows up in the local collector.
- An outbox → Kafka → consumer → inbox round-trip test passes.
- CI is green.

### Phase 1: Identity, user, gateway + web auth (frontend track A starts)

- [ ] identity-service: schema, register, verify, login, refresh rotation with reuse detection, logout(-all), forgot/reset, JWKS, socket ticket, Argon2id + bcrypt rehash, lockout, events, email job outbox.
- [ ] notification-service (email part): `email-send` worker, provider adapters, `email_log` dedupe.
- [ ] user-service: profiles from events, search (trigram/prefix), friends (canonical pairs), signed avatar upload, events.
- [ ] gateway: JWKS verification, RBAC table, rate limits, proxy routes, CSRF/Origin checks, OpenAPI aggregation at `/docs`.
- [ ] `apps/web`: Next.js skeleton, `packages/ui` (shadcn base, tokens, Storybook), auth pages, `middleware.ts`, rewrites, TanStack Query setup, friends and search pages.

**DoD:**

- E2E: register → verification email (fake inbox) → verify → login → refresh rotation → send, accept and remove a friend.
- Race test: concurrent A→B / B→A friend requests produce one row.
- Lighthouse on auth pages ≥ 90.

### Phase 2: Problems + judge (hosted Judge0)

- [ ] problem-service: schema, admin CRUD, test file upload to R2 (with size rules), reference solutions, `problem-calibrate`, publish rules, judge-spec internal API, selection API (idempotent), seen consumer.
- [ ] judge-service: `language_profiles` bootstrap from `/languages`, `/config_info` validation, submission intake (gates, cache, idempotency), `judge-submit`/`judge-run`/`judge-poll`, callback endpoint (HMAC), staged batching, classification + checkers (`domain/judge-core`), near-miss rerun, IE retry, budget counter, circuit breaker, capacity endpoint, drift job, events.
- [ ] Postgres-polling degraded mode for the judge worker (§18.1).
- [ ] Web: admin problem authoring UI (statement editor with markdown preview, test files, reference solutions, calibration report, publish).

**DoD:**

- With fake-judge0: every verdict path (AC/WA/TLE/MLE/RE/CE/OLE/IE) has passing tests.
- Callback and poll modes both work.
- Budget exhaustion blocks intake correctly.
- With real Judge0 (≤ 20 calls): one problem calibrated and judged end to end.

### Phase 3: Battle + realtime (the core)

- [ ] `domain/match-rules`: challenge and match state machines + winner resolution (earliest-submitted AC; deciding).
- [ ] battle-service: challenges (create/accept/reject/cancel/expire), start saga + compensation, `match_submissions` read model consumer, winner logic, forfeit, timeout job, reconciler (advisory lock), active match / state / history APIs, participation internal API, tab lease, admission control.
- [ ] realtime: ticket auth, local rooms, per-node Kafka consumer delivery, presence (per connection + TTL + debounce + friend fan-out), lobby and query HTTP APIs, rate limits, graceful shutdown.
- [ ] Web: lobby, challenge modal, battle room (CodeMirror, panels, timer with server offset, drafts in IndexedDB, results panel, opponent activity), end screen, rejoin banner, multi-tab alert.

**DoD:**

- Every row of the §12 race matrix has a passing test.
- E2E: two browsers play a full match: AC win, forfeit, and timeout.
- Chaos drill 2 (kill a realtime node) passes.
- Parity checklist items for challenge and match are ticked.

### Phase 4: Rating, leaderboard, notifications

- [ ] rating-service: stats from registration, ledger application (idempotent), ZSET, top-50/my-rank/friends leaderboard, Postgres fallback, rebuild job, stats history API.
- [ ] notification-service: in-app notifications from events, unread count, read APIs.
- [ ] gateway BFF: profile and lobby aggregation.
- [ ] Web: leaderboard (ISR + rank + presence dots), profile (charts, history), notification centre, on-demand revalidation.

**DoD:**

- Replaying `match.completed` 5× changes coins exactly once.
- Leaderboard is correct with Redis stopped.
- Every item in the §3 parity checklist is ticked.

### Phase 5: Frontend polish and performance (frontend track B)

- [ ] Bundle and performance budgets in CI, Lighthouse CI, virtualised lists, prefetching, animations, accessibility audit, mobile responsiveness, Storybook coverage for `packages/ui`, Playwright visual snapshots.

**DoD:**

- Performance budgets met on all routes.
- axe audit has no serious issues.

### Phase 6: Hardening

- [ ] k6 load tests (HTTP + WebSocket) on the VM against fake-judge0. Record p95s in the README.
- [ ] Chaos drills 1–4 (§18.6), scripted.
- [ ] Grafana dashboards (judge, matches, sockets, Kafka lag, budgets), alerts (email).
- [ ] Backups + restore drill. Security pass (OWASP ASVS L1 checklist, dependency audit).

**DoD:**

- Documented results for all drills and load tests.
- Restore drill succeeds.

### Phase 7: AI

- [ ] ai-service skeleton, ModelGateway, budget and quotas, local embeddings, ingestion (`content/dsa`, problems, editorials).
- [ ] Feature 1 (coach) → 2 (hints + leak guard + coin purchase) → 3 (RAG tutor) → 4 (recommendations) → 5 (generation agent) → 6 (anti-cheat flags).
- [ ] Eval suite + `ai_requests` dashboard.

**DoD:**

- Each feature sits behind a flag.
- Evals pass their thresholds (hint leak rate < 2% on the golden set; RAG faithfulness ≥ 0.85).
- Spend stays under the cap in a simulated busy day.

### Phase 8: Migration and cutover

- [ ] Run the migration script in dry-run against a v1 DB snapshot. Fix discrepancies.
- [ ] Deploy production compose to the VM, DNS, Vercel.
- [ ] Final migration, cutover, smoke tests. Archive `Client/` and `Server/` (move to `legacy/` or a tag).

**DoD:**

- v2 is live.
- Verification counts match.
- v1 is read-only and backed up.

---

## 26. Architecture Decision Records (index)

Create one file per ADR in `docs/adr/` with the sections Context, Decision, Consequences, Alternatives.

| ADR | Decision                                                                                                                                             | Key reason                                             | Rejected alternatives                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 001 | Microservices in a Turborepo + pnpm monorepo                                                                                                         | Different scaling profiles, isolation, interview depth | Modular monolith (valid; noted as the honest alternative)                                     |
| 002 | PostgreSQL, one DB per service; Drizzle                                                                                                              | Constraints/CAS/ACID, pgvector, pg_trgm                | MongoDB (v1), Prisma                                                                          |
| 003 | REST for commands, WebSocket push-only                                                                                                               | Idempotency, auth, testability; thin socket nodes      | Socket-command RPC (v1)                                                                       |
| 004 | Kafka for events + BullMQ for jobs                                                                                                                   | Different semantics (§10.1)                            | Kafka only; BullMQ/Redis Streams only                                                         |
| 005 | Transactional outbox + inbox                                                                                                                         | No dual writes; exactly-once effect                    | Publishing directly after commit; CDC/Debezium (too heavy for the VM)                         |
| 006 | Invariants through DB constraints + CAS; no Redlock                                                                                                  | Correctness under GC pauses and clock drift            | Redis distributed locks                                                                       |
| 007 | Earliest _submitted_ AC wins, with a `deciding` state                                                                                                | Fairness under variable judge latency                  | First judged AC                                                                               |
| 008 | Hosted Judge0 API behind `CodeExecutor`; few packed test files; staged batches; callbacks                                                            | Owner won't self-host; ₹0 budget                       | Self-hosted Judge0 / isolate (future swap)                                                    |
| 009 | Realtime delivery through per-node Kafka consumer groups                                                                                             | Redis-independent delivery; no cross-node joins        | Socket.IO Redis adapter in the critical path                                                  |
| 010 | EdDSA JWT (15 min) + rotating refresh tokens + socket tickets                                                                                        | Stateless verification, revocation, cross-origin WS    | Long-lived JWT in a cookie (v1)                                                               |
| 011 | Next.js App Router on Vercel; CodeMirror 6; TanStack Query + Zustand                                                                                 | SSR/ISR for public pages, small bundles                | Vite SPA (v1), Monaco, Redux                                                                  |
| 012 | ₹0 hosting: Oracle A1 VM + Vercel + self-hosted PG/Redis/Redpanda                                                                                    | Free; always-on workers                                | Render/Fly/Koyeb (sleep, no free tier), Neon (pollers burn CU-hours), Upstash (command quota) |
| 013 | Lobby: live push for online friends only; other online players as a paginated, prefix-searchable pull list (ZSET by recency + lex ZSET) with a count | Removes O(N²) broadcast; the cost is O(page size)      | Global live broadcast (v1); live push of every online user                                    |

---

## 27. Interview talking points (with where each is implemented)

1. **Server-authoritative game state:** v1 trusted the client to declare the winner (§4 #1). v2 decides from judge events (§11.3).
2. **One active match per user** with a PK table instead of locks; how it resolves A→B / B→A (§11.2, §12).
3. **Fairness:** earliest _submitted_ AC + the `deciding` state; why "first judged" is unfair (§11.3).
4. **Outbox + inbox:** why dual writes are wrong; exactly-once effect on top of at-least-once delivery (§10.3).
5. **Idempotency everywhere:** HTTP keys, CAS, the ledger's unique key, `jobId`, making Judge0's non-idempotent POST safe (§12, §14.4).
6. **Timers:** why Redis keyspace notifications fail; BullMQ delayed jobs + a Postgres-leader reconciler (§11.4).
7. **Kafka vs BullMQ:** semantics, head-of-line blocking, partitions as the unit of parallelism (§10.1).
8. **Realtime at scale:** ticket auth, per-node delivery, presence with TTL and debounce, O(friends) fan-out, seq/resync (§13).
9. **Judge on a quota:** packing, staging, fail fast, caching, admission control, degradation ladder (§14.6).
10. **Measuring time correctly:** CPU vs wall time, soft/hard limits, calibration from reference solutions (Kattis/Polygon), drift factor (Codeforces-style ×2) (§14.5–14.8).
11. **Failure design:** what happens when Redis, Kafka, Judge0 or AI are down; chaos drills (§18).
12. **Leaderboard:** ZSET O(log N) rank + tie-break + Postgres fallback + atomic rebuild (§15).
13. **Auth:** refresh rotation with reuse detection, JWKS, CSRF, cross-origin WebSocket tickets (§16, §13.1).
14. **Data modelling:** canonical friendship pairs, partial indexes, UUIDv7 locality, partitioned submissions (§9).
15. **AI done properly:** RAG with hybrid search + RRF, leak guard, budgets, evals, agentic generation with tool use and self-verification (§22).
16. **Capacity math** and what changes at 100× (self-hosted judge, KEDA, more partitions) (§17.4).
17. **Cost engineering:** running a full microservice system for ₹0 and knowing every free tier's limits (§23).

---

## 28. Verify before relying (facts that change over time)

Checked on **2026-11-08**. Re-check these before decisions that depend on them:

- Hosted Judge0 quotas and pricing (RapidAPI Basic plan daily limit **not verified**; judge0.com €27/2000/day and €54/5000/day are from a third-party report), `max_submission_batch_size`, the limit maximums from `/config_info`, and how callback bodies encode base64 fields. Handle both encodings.
- Oracle Always Free A1 limits (2 OCPU / 12 GB since Aug 2026) and the idle-reclamation policy.
- Neon free plan (100 projects, 1 GB/project, 100 CU-h/project/month), Upstash free (500K commands/month, 256 MB), Aiven free Kafka (5 topics × 2 partitions, 250 KiB/s, powers off when idle).
- Render, Fly.io and Koyeb free tiers. As of this date: Render sleeps after 15 min with a 750 h pool; Fly.io has a trial only; Koyeb's free plan is closed to new users.
- Email provider free tiers (Resend, Brevo, SendGrid).
- Vercel Hobby terms (non-commercial).
- How Codeforces and LeetCode judge internally is **not officially documented**. Our design follows the **documented** DOMjudge, Kattis and isolate behaviour.

### References

- Judge0 CE API docs: https://ce.judge0.com/ · Judge0 plans: https://judge0.com/
- isolate man page: https://mj.ucw.cz/moe/isolate.1.html
- DOMjudge judging docs: https://www.domjudge.org/docs/manual/main/judging.html · config ref: https://www.domjudge.org/docs/manual/main/conf_ref.html
- Kattis problem package format: https://www.kattis.com/problem-package-format/spec/2025-09.html · legacy: https://www.kattis.com/problem-package-format/spec/legacy.html
- Codeforces timing discussion: https://codeforces.com/blog/entry/85677 · rules: https://codeforces.com/blog/entry/4088
- Aiven free Kafka: https://aiven.io/docs/products/kafka/free-tier/kafka-free-tier
- Upstash pricing: https://upstash.com/docs/redis/overall/billing
- Neon free plan: https://neon.com/faqs/free-plan-limits-and-quotas
- Oracle A1 cut: https://linuxiac.com/oracle-quietly-cuts-free-tier-ampere-a1-resources-in-half/
- Hosting free tiers comparison: https://flaviocopes.com/hosting-free-tiers/
- Redingle reference repo (local): `C:\Users\praba\Desktop\Redingle\aa-services` (Turborepo layout, package kinds, AGENTS.md conventions)

---

## 29. Progress tracker (update as you go)

| Phase                                  | Status         | Notes / links                                       |
| -------------------------------------- | -------------- | --------------------------------------------------- |
| 0 Foundation                           | ✅ Done        | PR #1 merged 2026-11-10.                            |
| 1 Identity / User / Gateway / Web auth | 🟡 In progress | Branch `phase-1/identity`. See "Resume here" below. |
| 2 Problems + Judge                     | ⬜             |                                                     |
| 3 Battle + Realtime                    | ⬜             |                                                     |
| 4 Rating / Leaderboard / Notifications | ⬜             |                                                     |
| 5 Frontend polish                      | ⬜             |                                                     |
| 6 Hardening                            | ⬜             |                                                     |
| 7 AI                                   | ⬜             |                                                     |
| 8 Migration + Cutover                  | ⬜             |                                                     |

### Resume here (Phase 1 status, 2026-11-11, part 3)

Phase 0 is merged (PR #1): root config, `@cb/contracts`, the platform libs in `packages/libs`, fake-judge0, template-service, compose stack, CI, ADRs.

**Phase 1 done and tested** (part 1 = PR #2, part 2 = PR #3, part 3 on branch `phase-1/gateway`):

- `@cb/contracts`: auth DTOs and cookie/CSRF constants (`http/auth.ts`), identity events (`identityEvents`), `email-send` job payload (`jobs/email.ts`).
- `@cb/auth` (new lib): `TokenSigner` (EdDSA access tokens + socket tickets, key rotation by `kid`), `JwtVerifier` (local or remote JWKS), Fastify hooks `authenticate` / `optionalAuth` / `requireRole` / `requireVerified` / `csrfGuard`.
- `apps/identity-service` (port 4001): register, verify-email, resend-verification, login (username or email), refresh rotation with reuse detection and a 10 s multi-tab grace, logout, logout-all, forgot/reset password, me, socket-ticket, JWKS. Argon2id + bcrypt rehash, lockout after 10 failures, per-route rate limits, idempotent registration, outbox events, email jobs via job outbox, leader-elected sweeper. 21 integration tests (Testcontainers), including race tests.
- `apps/notification-service` (port 4003, email part): `email-send` worker, `EmailProvider` with Brevo + fake inbox (`GET /internal/dev/inbox?to=`), `email_log` claim-before-send dedupe, permanent vs retryable errors, daily cap that defers jobs to next UTC midnight, provider rate limit, dead letters without links. 8 integration tests. Verified end to end in dev: register → email in fake inbox → verify → `ev=true` after refresh.
- `apps/user-service` (port 4002): profiles from `identity.user.registered.v1` (inbox, exactly once), `GET /users/me|:username` (with viewer `relationship`), `PATCH /users/me` (+ `user.profile.updated.v1`), prefix search with keyset pagination + trigram fallback, signed Cloudinary avatar uploads (own `public_id` only), `/internal/users/batch` behind service tokens. Friends: request (mutual request = instant friends), accept, silent reject, cancel, remove, paginated lists, `user.friendship.changed.v1` keyed by `user_low`. 13 integration tests incl. the A→B / B→A race (one row). Verified in dev across identity → Kafka → user-service with real identity tokens via JWKS.
- `@cb/auth` also has internal service tokens (`signInternalToken`, `createInternalAuth`, HS256, `aud=cb-internal`).
- `apps/gateway` (port 8080): route table with per-prefix access (`public` / `optional` / `user` / `verified` / role), JWKS verification, strips client-sent `x-user-*` / `x-internal-*` and sets them from the token, `x-forwarded-for` from trusted proxies only, Origin check + `x-cb-csrf`, per-IP limit with `RateLimit-*` headers, `/internal/*` and path-traversal blocked, upstream failures mapped to 503/504/502 in the standard error body, `/health/upstreams`, `/docs` (Swagger UI over each service's `/openapi.json`, trimmed to public paths). 12 integration tests against fake upstreams. Verified in dev: the whole Phase 1 flow through the gateway with a cookie jar.
- `@cb/http-server` can generate OpenAPI from zod schemas (`openapi` option → `GET /openapi.json`); identity and user enable it.
- `pnpm gen-keys` prints a `JWT_KEYS` value. Services load `.env` in dev (`--env-file-if-exists`); see each app's `.env.example`.

**Remaining for Phase 1** (in this order):

1. `apps/web`: Next.js skeleton, `packages/ui`, auth pages, `middleware.ts`, rewrites, TanStack Query, friends and search pages.
2. Run the Phase 1 DoD (§25) end to end in the browser (the backend flow already passes through the gateway) (register → email → verify → login → refresh → friends), then merge.

Deferred: an identity admin endpoint to change roles (the `identity.user.role_changed.v1` contract exists). Avatar uploads need `CLOUDINARY_*` env vars from the owner.

**Notes:**

- Images pinned: `postgres:16-alpine`, `redis:7-alpine`, `redpandadata/redpanda:v26.2.6`, `jaegertracing/jaeger:2.23.0`.
- Installed majors are newer than older docs: Vitest 5, ESLint 10, BullMQ 6, `fastify-type-provider-zod` 7, testcontainers 12, zod 4, drizzle-orm 0.45.
- BullMQ job IDs must match `[A-Za-z0-9_.-]` (no colons), e.g. `match-timeout-<matchId>`. Supersedes the colon-style IDs written in §10.4.
- The `@cb/http-server` unit test once timed out while all package tests ran in parallel. It passes alone and on rerun. If it recurs, raise the Vitest `testTimeout`.

**Decision log (append-only):**

- 2026-11-08: Plan approved. Hosted Judge0 only; few packed test files with staged batches to minimise quota; ₹0 hosting target; Next.js frontend; Postgres for all transactional data; Kafka + BullMQ; Redis is never a correctness dependency.
- 2026-11-10: Phase 1 identity decisions. Refresh cookie path is `/api/v1/auth` (logout must read it). A rotated refresh token reused within 10 s returns 409 (multi-tab race) instead of revoking the family. Login accepts username or email (v1 used username). Registration does not log the user in (the stored idempotent replay can't re-set cookies); the web app calls login next. No email or token is put on Kafka; dispatched email job rows are purged after 10 min.
- 2026-11-10: Email provider is **Brevo** (free tier ~300/day shared; third-party sources, re-verify per §28). `email_log` adds `status` (pending/sending/sent/failed), `attempts`, `last_error`, `sent_at`; the recipient is stored only as a hash. Daily cap default 280. `email-send` retry policy lives in `@cb/contracts` (`EMAIL_JOB_RETRY`, 8 attempts, exponential from 5 s).
- 2026-11-10: user-service decisions. Friend requests by `toUserId`; a mutual request accepts immediately; reject is silent (the requester keeps seeing "pending", the row is `ignored`); added `DELETE /friends/requests/:otherUserId` (cancel). Sending a request needs a verified email and an Idempotency-Key, 30/hour per user. Reserved usernames (e.g. `search`, `admin`) are refused at registration because `/users/:username` shares the path space. A brand-new user's profile can 404 for a moment until the registration event is consumed.
- 2026-11-11: Gateway decisions. Client IP comes from `TRUSTED_PROXIES` (addresses/CIDRs, e.g. Caddy's Docker network); Fastify now ignores hop counts because they can't prove the peer is a proxy. Internal services keep `trustProxy: true`, so they must never publish ports outside the Docker network. The gateway enforces only the global per-IP limit; route-specific limits live in the owning service. `/api/v1/auth/*` is `public` at the gateway so an expired access cookie can still reach `/auth/refresh`. Redpanda Console moved to port 8081 (8080 is the gateway). Kept Fastify over Express after discussing it with the owner (Express-like API; zod schemas give validation, types and OpenAPI).
