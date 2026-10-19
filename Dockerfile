# syntax=docker/dockerfile:1.7
# Multi-stage image for Cloud Run. Targets: runtime (the app), migrate (prisma migrate deploy), bootstrap (one-time DB roles).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts && npx prisma generate

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && mkdir -p public

# ── app ──
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd -r app -g 10001 && useradd -r -g app -u 10001 -M -s /usr/sbin/nologin app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER 10001
EXPOSE 8080
CMD ["node", "server.js"]

# ── migrations (Cloud Run Job; uses the OWNER login, never the app's) ──
FROM deps AS migrate
ENV NODE_ENV=production
COPY prisma ./prisma
COPY prisma.config.ts ./
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ── one-time role bootstrap (Cloud Run Job; admin login). See docs/GCP-SETUP.md ──
FROM postgres:16-alpine AS bootstrap
COPY scripts/db-bootstrap.sql /sql/db-bootstrap.sql
COPY scripts/db-bootstrap.sh /usr/local/bin/db-bootstrap.sh
RUN chmod +x /usr/local/bin/db-bootstrap.sh
USER postgres
ENTRYPOINT ["/usr/local/bin/db-bootstrap.sh"]
