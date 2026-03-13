FROM node:24-alpine AS deps

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/auth/package.json apps/auth/package.json
COPY apps/sql-api/package.json apps/sql-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent-shared/package.json packages/agent-shared/package.json
COPY infra/aws/package.json infra/aws/package.json
RUN npm ci

FROM node:24-alpine AS builder

WORKDIR /workspace

COPY --from=deps /workspace/node_modules ./node_modules
COPY . .
RUN npm run build --workspace expense-tracker-auth

FROM node:24-alpine AS prod-deps

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/auth/package.json apps/auth/package.json
COPY apps/sql-api/package.json apps/sql-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/agent-shared/package.json packages/agent-shared/package.json
COPY infra/aws/package.json infra/aws/package.json
RUN npm ci --omit=dev

FROM node:24-alpine

WORKDIR /app/apps/auth

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 auth

ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem

COPY --from=prod-deps /workspace/node_modules /app/node_modules
COPY --from=builder /workspace/packages/agent-shared/package.json /app/packages/agent-shared/package.json
COPY --from=builder /workspace/packages/agent-shared/dist /app/packages/agent-shared/dist
COPY --from=builder /workspace/apps/auth/package.json ./package.json
COPY --from=builder /workspace/apps/auth/dist ./dist

USER auth
EXPOSE 8081
CMD ["node", "dist/index.js"]
