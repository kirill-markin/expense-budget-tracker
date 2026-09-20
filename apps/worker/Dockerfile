# Built from the repository root: this is an npm workspace and the only
# lockfile lives there (see apps/auth/Dockerfile for the same layout).
FROM node:24.21.0-alpine AS npm
RUN npm install --global npm@12.0.2

FROM npm AS deps

WORKDIR /workspace

COPY .npmrc package.json package-lock.json ./
COPY apps/auth/package.json apps/auth/package.json
COPY apps/sql-api/package.json apps/sql-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent-shared/package.json packages/agent-shared/package.json
COPY infra/aws/package.json infra/aws/package.json
RUN npm ci

FROM node:24.21.0-alpine AS builder

WORKDIR /workspace

COPY --from=deps /workspace/node_modules ./node_modules
COPY . .
RUN cd apps/worker && ../../node_modules/.bin/tsc -p tsconfig.json

FROM npm AS prod-deps

WORKDIR /workspace

COPY .npmrc package.json package-lock.json ./
COPY apps/auth/package.json apps/auth/package.json
COPY apps/sql-api/package.json apps/sql-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent-shared/package.json packages/agent-shared/package.json
COPY infra/aws/package.json infra/aws/package.json
RUN npm ci --omit=dev

FROM node:24.21.0-alpine

WORKDIR /app/apps/worker

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker

COPY --from=prod-deps /workspace/node_modules /app/node_modules
COPY --from=builder /workspace/apps/worker/package.json ./package.json
COPY --from=builder /workspace/apps/worker/dist ./dist

USER worker
CMD ["node", "dist/scheduler.js"]
