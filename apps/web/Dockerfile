# --- Stage 1: Install dependencies ---
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Stage 2: Build ---
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Stage 3: Production runner ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# RDS certificates are signed by Amazon's own CA which is NOT in the
# standard Node.js trust store. Download the official AWS RDS CA bundle
# so that NODE_EXTRA_CA_CERTS (set in CDK) lets Node.js verify the
# RDS certificate without disabling validation (rejectUnauthorized:false).
# Bundle URL: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
# Docker ADD from URL creates files as root:root with 600 permissions.
# chmod so the non-root nextjs user can read it at runtime.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

# Shell form: HOSTNAME= overrides the ECS Fargate-injected HOSTNAME
# (ECS sets HOSTNAME to the task ID, breaking Next.js localhost binding).
# See https://github.com/vercel/next.js/issues/58657
CMD HOSTNAME="0.0.0.0" node server.js
