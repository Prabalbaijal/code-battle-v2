# syntax=docker/dockerfile:1.7
# Generic image for any Node app in the monorepo (plan §23.4).
#   docker build -f infra/docker/node-app.Dockerfile --build-arg APP=@cb/template-service .
# Override CMD for workers: ["node","--import","./dist/instrument.js","dist/worker.js"]
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.34.9 turbo@2.11.10

# 1. Prune the monorepo to just APP and its workspace dependencies.
FROM base AS pruner
ARG APP
WORKDIR /repo
COPY . .
RUN turbo prune "${APP}" --docker

# 2. Install (cached by lockfile), build, then create a production-only deployment folder.
FROM base AS builder
ARG APP
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
# turbo prune does not copy root config files that packages extend
COPY --from=pruner /repo/tsconfig.base.json ./
RUN pnpm turbo run build --concurrency=2 --filter="${APP}..."
RUN pnpm --filter="${APP}" deploy --prod --legacy /out

# 3. Small runtime image, non-root.
FROM node:${NODE_VERSION}-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /out ./
USER node
CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
