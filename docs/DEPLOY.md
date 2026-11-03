# Deployment Runbook

End-to-end procedure for shipping Fernly to a production host. The
canonical deployment target is a single Linux host running
`docker compose` (migration gate + 2 app replicas + nginx + Redis +
maintenance cron; an optional bundled PostgreSQL via the `local-db`
profile). The same procedure applies to staging; only the env file differs.

**Prerequisites:** the host has Docker 24+ and the Docker Compose v2
plugin installed, ports 80/443 are open, and you have SSH access.

---

## 1. First-time deploy

### 1.1 Prepare the host

```bash
ssh ops@your-host
mkdir -p /opt/fernly && cd /opt/fernly
```

Copy these files into `/opt/fernly/`:
- `Dockerfile`
- `docker-compose.yml`
- `nginx.conf`
- `deploy/` (TLS examples + production Caddyfile)
- `.env` (real production values — never commit; start from `.env.example`)

### 1.2 Configure the production `.env`

Open `.env` (copy from `.env.example` — every variable is documented there)
and set at minimum:

```bash
# Required — refuse to boot without these in production.
# Self-hosted with the bundled db (add --profile local-db below):
#   postgresql://fernly:<DB_PASSWORD>@db:5432/fernly
# Managed Postgres (Supabase/Neon/RDS) — use the POOLER host:
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@<pooler-host>:5432/postgres
POSTGRES_PASSWORD=<DB_PASSWORD>     # only needed for the local-db profile
NEXTAUTH_SECRET=$(openssl rand -base64 32)
NEXTAUTH_URL=https://your-production-domain.example
APP_URL=https://your-production-domain.example
SERVER_ACTIONS_ALLOWED_ORIGINS=https://your-production-domain.example

# Email (password reset) — without this, reset emails are silently dropped.
RESEND_API_KEY=re_xxx
MAIL_FROM="Fernly <onboarding@your-domain.example>"

# Shared rate limiting across the 2 replicas.
REDIS_URL=redis://redis:6379
REDIS_KEY_PREFIX=fernly:
# Optional (PR-33): require AUTH on the compose Redis. Setting this one
# variable wires BOTH sides (redis-server --requirepass + the app URL).
# REDIS_PASSWORD=$(openssl rand -base64 24)

# Cron + metrics (daily maintenance at 03:00 UTC: audit retention +
# expired-token, read-notification and stale read-state purges; also the
# bearer token for the /api/metrics Prometheus endpoint).
CRON_SECRET=$(openssl rand -base64 32)

# Optional but recommended.
SENTRY_DSN=https://xxx@sentry.io/xxx
SENTRY_ENVIRONMENT=production

# Optional hardening — see .env.example for the full contract:
#   PASSWORD_BREACH_CHECK=1 / HIBP_API_KEY  (breach-list password checks;
#     egress to api.pwnedpasswords.com:443 required, PR-35)
#   HSTS_INCLUDE_SUBDOMAINS=1 / HSTS_PRELOAD=1  (irreversible — only when
#     every subdomain serves HTTPS, PR-36)
```

### 1.3 Build + start

```bash
# Build the images (multi-stage; ~30s on a 2-core host).
docker compose build

# Fully self-hosted stack (bundled PostgreSQL):
docker compose --profile local-db up -d

# …or with an external managed Postgres (DATABASE_URL points at it):
docker compose up -d

# Plain `docker compose` ignores `deploy.replicas` — scale explicitly
# to actually run 2 app containers behind nginx:
docker compose up -d --scale fernly-1=2

# Wait for the health checks to go green (max 60s).
docker compose ps
# All services should show Up (healthy); `migrate` shows Exited (0).

# Smoke check the public endpoint.
curl -fsS https://your-production-domain.example/api/health
# → {"status":"ok","timestamp":"..."}
```

The `migrate` one-shot service runs `prisma migrate deploy` (retrying while
the DB accepts connections) and the app containers only start after it
succeeds — a failed migration fails the deploy loudly instead of serving a
mismatched schema.

### 1.4 Database schema

The `migrate` service already applied all migrations before the app started
(the PR-24 startup gate). Verify with:

```bash
docker compose run --rm migrate bunx prisma migrate status --schema prisma/schema.prisma
# → "Database schema is up to date!"
```

(If you ever need to run one manually: `docker compose run --rm migrate` —
the app image itself ships no Prisma CLI/migrations by design.)

### 1.5 Seed an admin

If you didn't seed demo accounts, create the first admin directly in the
database (the app image ships no Prisma CLI by design — PR-24):

```bash
# Local bundled db profile:
docker compose exec db psql -U fernly -d fernly
# …or connect psql to your managed Postgres / Supabase pooler.
```

Insert a `User` row with `role: ADMIN` and a bcrypt-hashed password
(hash locally: `node -e "console.log(require('bcryptjs').hashSync('YourPassword1', 12))"`):

```sql
INSERT INTO "User" (id, email, name, role, "passwordHash", "tokenVersion", "createdAt", "updatedAt")
VALUES ('u-admin', 'admin@example.com', 'Admin', 'ADMIN',
        '<bcrypt hash from above>', 0, now(), now());
```

(Sign-in filters `deletedAt IS NULL`, which is the column default — no extra
values needed. Every other column has a default too.)

### 1.6 Smoke test

- Browse to `https://your-production-domain.example/` — login screen.
- Sign in as the admin.
- Verify the dashboard loads, the API discovery at `/api` works, and
  `/api/health` returns 200.
- **Production-build smoke (PR-37):** from a machine with the repo checked
  out, `bun run build && bun run test:prodsmoke` boots the standalone
  build on a scratch port and verifies boot, login-page SSR, security
  headers, credential login (good + bad), the authenticated shell, and the
  health/metrics auth gates — 10 checks, zero browser dependency.

---

## 2. Routine deploy (rolling update)

The 2-replica compose + nginx passive health checks (`max_fails 3`,
`fail_timeout 30s`) make rolling updates zero-downtime.

```bash
cd /opt/fernly

# Pull the latest code (or copy the new Dockerfile/compose/env).
git pull   # if you keep the deploy files in a private repo

# Rebuild + recreate one service at a time. Docker Compose's default
# `up -d` recreates containers in dependency order; nginx keeps routing
# to the healthy replica while the other restarts.
docker compose build
docker compose up -d

# Watch the rollout.
docker compose ps
docker compose logs -f --tail=50 fernly-1 fernly-2
```

If a new migration ships with the deploy, `docker compose up -d` runs it
via the `migrate` gate automatically; then restart both replicas so they
pick up the generated client:

```bash
docker compose build && docker compose up -d --scale fernly-1=2
docker compose restart fernly-1
```

---

## 3. Rollback

If the new version is broken, roll back to the previous image:

```bash
cd /opt/fernly

# 1. Identify the previous image tag (Docker keeps layered history).
docker images fernly --format "table {{.ID}}\t{{.CreatedAt}}\t{{.Size}}"

# 2. Pin docker-compose.yml to that image ID (image: fernly:<sha>)
#    instead of building from source, then:
docker compose up -d

# 3. If a migration ran with the broken deploy, roll it back manually
#    per docs/BACKUP_RECOVERY.md §"Manual rollback". Prisma does NOT
#    auto-rollback migrations — pre-write down.sql for destructive ones.
```

For database-level rollback (PITR), follow
[`docs/BACKUP_RECOVERY.md`](./BACKUP_RECOVERY.md).

---

## 4. Staging

Mirror the production setup with a separate Supabase staging project
and a separate `.env.staging`. Useful for:

- Running the PITR restore drill before doing it on prod.
- Testing migrations against a real Postgres before applying to prod.
- Verifying a new deploy doesn't regress before promoting.

The recommended promotion path is `feature branch → CI green →
staging deploy → smoke test → production deploy`.

---

## 5. Health monitoring

- **Liveness/readiness:** `GET /api/health` returns 200 with
  `{ "status": "ok", "timestamp": … }` and 503 when the DB is unreachable.
  Suitable for k8s probes / Docker `HEALTHCHECK` / nginx passive checks.
  With `?detail=1` + `Authorization: Bearer $CRON_SECRET` it also reports
  `db` and `redis`.
- **Through the LB:** `http://<host>/health` is nginx's own liveness (static);
  point external uptime monitors at `http://<host>/upstream-health` — it
  proxies the app's full DB+Redis probe and is the honest "site is up"
  signal.
- **Logs:** `docker compose logs -f fernly-1` — structured JSON from
  the proxy middleware, plus console output from the app.
- **Sentry:** if `SENTRY_DSN` is set, uncaught server + client errors
  forward automatically.
- **Maintenance cron:** the `audit-cron` service calls
  `/api/cron/prune-audit` daily at 03:00 UTC (audit retention + the PR-17
  purges); check its logs with `docker compose logs audit-cron`. Since
  PR-30 the overlap guard is a Redis `SET NX PX` lock shared by both
  replicas, so a doubled cron trigger runs the pass exactly once; the
  response's `lockBackend` field says which backend guarded the run
  (`redis` / `memory`).
- **Prometheus metrics (PR-32):** `GET /api/metrics` serves the standard
  text exposition format — per-instance gauges for app/DB/Redis up-ness,
  process uptime + memory, event-loop lag, and the last successful
  maintenance run (`fernly_maintenance_last_run_timestamp_seconds` — alert
  when it goes stale > 36 h). Auth is the same `CRON_SECRET` bearer token;
  unset = 503. Request-level signals stay in the structured logs
  (`metric=http_request` lines). Example scrape job:

  ```yaml
  scrape_configs:
    - job_name: fernly
      scheme: https
      authorization: { credentials: "<CRON_SECRET>" }
      metrics_path: /api/metrics
      static_configs: [{ targets: ["app.example.com"] }]
  ```

## 5a. TLS

The compose stack serves HTTP on :80. Terminate TLS ONE of these ways
(pick one — the app's HSTS header becomes effective only after this):

1. **Caddy edge (recommended, automatic Let's Encrypt):** install Caddy on
   the host, point DNS at it, and use `deploy/Caddyfile.production`
   (`FERNLY_DOMAIN=app.example.com`). Zero cert management.
2. **nginx TLS:** swap `nginx.conf` for `deploy/nginx-tls.conf.example` and
   mount `./deploy/certs` (see the header comment in that file). Certbot
   renewals keep working via the open ACME path on :80.
3. **External load balancer / CDN** (cloud LB, Cloudflare): terminate TLS
   there and forward to :80 — X-Forwarded-* headers are already respected.

---

## 6. Common operations

| Operation | Command |
|---|---|
| Tail logs (all services) | `docker compose logs -f --tail=100` |
| Tail logs (one replica) | `docker compose logs -f fernly-1` |
| Restart one replica | `docker compose restart fernly-1` |
| Restart everything | `docker compose restart` |
| Open a shell in a replica | `docker compose exec fernly-1 /bin/sh` |
| Apply migrations (manual) | `docker compose run --rm migrate` |
| Check migration status | `docker compose run --rm migrate bunx prisma migrate status --schema prisma/schema.prisma` |
| Inspect Redis | `docker compose exec redis redis-cli INFO` |
| Reload nginx config | `docker compose exec nginx nginx -s reload` |
| Pull an image-only update | `docker compose pull && docker compose up -d` |

---

## 7. Post-deploy checklist

- [ ] `/api/health` (or `/upstream-health` through the LB) returns 200.
- [ ] Login works as the admin account.
- [ ] Login works for a MEMBER (lowest privilege).
- [ ] A non-existent email returns the same UI as a wrong password.
- [ ] Password reset email arrives within 60s (if Resend is wired).
- [ ] Audit log records `auth.signed_in` for the test login.
- [ ] `docker compose ps` shows all services Up (healthy).
- [ ] `docker compose logs --tail=200 fernly-1 fernly-2` shows no
      uncaught errors in the last 5 minutes.
