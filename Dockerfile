# L-P1-21 — Multi-stage Dockerfile. Standalone output, non-root user,
# HEALTHCHECK probing /api/health (L-P0-4). See docker-compose.yml for
# multi-instance deployment (2 replicas + nginx LB + Redis).

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN bunx prisma generate

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_SEED_DEMO=0
ENV NEXT_PUBLIC_SEED_DEMO=$NEXT_PUBLIC_SEED_DEMO
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN bun run build

FROM oven/bun:1-slim AS migrator
WORKDIR /app
# PR-24 (production-readiness audit) — one-shot migration runner. The runner
# stage below intentionally ships ONLY the standalone output (no prisma/
# folder, no Prisma CLI), so the previously documented
# `docker compose exec fernly-1 bunx prisma migrate deploy` could never work:
# neither the migrations nor the CLI exist inside that image. This stage
# carries both and exits after `migrate deploy`. docker-compose.yml wires it
# as a startup gate (fernly-1 waits for service_completed_successfully).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package.json ./
# Retry loop: tolerates a cold-starting database (bundled compose `db` service
# or a managed DB still accepting connections) for up to ~60s before failing.
CMD ["sh", "-c", "for i in $(seq 1 30); do bunx prisma migrate deploy --schema prisma/schema.prisma && exit 0; echo '[migrate] database not ready yet, retrying in 2s'; sleep 2; done; echo '[migrate] FAILED: database never became ready'; exit 1"]

FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
USER nextjs
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Launch-crosscheck security fix: Next.js copies .env files into the
# standalone output when they exist at build time. Even with .dockerignore
# excluding them from the context, defense in depth — the runtime image must
# NEVER contain secrets; configuration is injected at runtime via compose
# `env_file` / orchestrator env.
RUN rm -f ./.env ./.env.local ./.env.production ./.env.development
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server.js"]
