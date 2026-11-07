# Code Battle v2

Real-time 1v1 competitive coding: challenge an online player, both get the same unseen problem, and the first accepted solution wins.

v2 is a TypeScript rewrite of [Code Battle v1](https://github.com/Prabalbaijal/Code_Battle) as an event-driven microservice system in a Turborepo monorepo.

- **Architecture, decisions and roadmap:** [CODE_BATTLE_V2_PLAN.md](./CODE_BATTLE_V2_PLAN.md) (single source of truth)
- **Status:** Phase 0 (Foundation) in progress

## Requirements

- Node.js ≥ 22, pnpm 10 (`npm i -g pnpm@10`)
- Docker Desktop (local infrastructure and integration tests)

## Quick start

```bash
pnpm install
pnpm infra:up        # postgres, redis, redpanda, fake-judge0, otel-collector
pnpm build
pnpm test            # unit tests
pnpm test:int        # integration tests (needs Docker)
```
