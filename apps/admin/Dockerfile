# --- Stage 1: Install dependencies ---
FROM node:24.22.3-alpine AS npm
RUN npm install --global npm@12.2.3

FROM npm AS deps
WORKDIR /workspace
# Only the admin workspace manifest is copied: `npm ci` reconciles the lockfile
# without the others, and the image carries no dependency of another app.
COPY .npmrc package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
RUN npm ci

# --- Stage 2: Build ---
FROM npm AS builder
WORKDIR /workspace
COPY --from=deps /workspace/node_modules ./node_modules
# The root manifests mark /workspace as the root Next traces from, so the
# standalone server lands under apps/admin like the web image.
COPY package.json package-lock.json ./
COPY apps/admin apps/admin
# globals.css imports these two web stylesheets by relative path.
COPY apps/web/src/app/styles/tokens.css apps/web/src/app/styles/tokens.css
COPY apps/web/src/app/styles/reset.css apps/web/src/app/styles/reset.css
RUN cd apps/admin && ../../node_modules/.bin/next build

# --- Stage 3: Production runner ---
FROM node:24.22.3-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# RDS certificates are signed by Amazon's own CA, which is not in the Node.js
# trust store; NODE_EXTRA_CA_CERTS (set in CDK) points at this bundle.
# Bundle URL: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html
# ADD from a URL creates a root-only file, so chmod lets nextjs read it.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem

COPY --from=builder --chown=nextjs:nodejs /workspace/apps/admin/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/admin/.next/static ./apps/admin/.next/static

WORKDIR /app/apps/admin

USER nextjs

EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

# Shell form: HOSTNAME= overrides the task ID ECS Fargate injects as HOSTNAME,
# which breaks Next.js binding. See https://github.com/vercel/next.js/issues/58657
CMD HOSTNAME="0.0.0.0" node server.js
