# syntax=docker/dockerfile:1.7
# The Next.js web app as a self-contained server (output: 'standalone').
#   docker build -f infra/docker/web.Dockerfile -t cb/web .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@10.34.9 turbo@2.11.10

FROM base AS pruner
WORKDIR /repo
COPY . .
RUN turbo prune @cb/web --docker

FROM base AS builder
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
COPY --from=pruner /repo/tsconfig.base.json ./
# production build: no dev-only REALTIME_ORIGIN, so the CSP allows connections to this origin only
ENV NEXT_STANDALONE=1 NODE_ENV=production
RUN pnpm turbo run build --filter=@cb/web...

FROM node:${NODE_VERSION}-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
