FROM node:24.18.0-alpine AS npm
RUN npm install --global npm@12.0.1

FROM npm AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM npm

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/

USER worker
CMD ["node", "dist/scheduler.js"]
