# Deployment Runbook

End-to-end procedure for shipping Fernly to a production host. The
canonical deployment target is a single Linux host running
`docker compose` (2 app replicas + nginx + Redis + audit-cron). The
same procedure applies to staging; only the env file differs.

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
- `.env` (real production values — never commit)

### 1.2 Configure the production `.env`

Open `.env` and set every variable per `.env.example`. Critically:

```bash
# Required — refuse to boot without these in production.
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@<pooler-host>:5432/postgres
NEXTAUTH_SECRET=$(openssl rand -base64 32)
NEXTAUTH_URL=https://your-production-domain.example
SERVER_ACTIONS_ALLOWED_ORIGINS=https://your-production-domain.example

# Email (password reset) — without this, reset emails are silently dropped.
RESEND_API_KEY=re_xxx
MAIL_FROM="Fernly <onboarding@your-domain.example>"

# Shared rate limiting across the 2 replicas.
REDIS_URL=redis://redis:6379
REDIS_KEY_PREFIX=fernly:

# Cron (audit prune at 03:00 UTC daily).
CRON_SECRET=$(openssl rand -base64 32)

# Optional but recommended.
SENTRY_DSN=https://xxx@sentry.io/xxx
SENTRY_ENVIRONMENT=production
```

### 1.3 Build + start

```bash
# Build the image (multi-stage; ~30s on a 2-core host).
docker compose build

# Start everything in detached mode.
docker compose up -d

# Wait for the health checks to go green (max 60s).
docker compose ps
# All services should show Up (healthy).

# Smoke check the public endpoint.
curl -fsS https://your-production-domain.example/api/health
# → {"status":"ok","db":"up","redis":"up","timestamp":"..."}
```

### 1.4 Apply DB migrations

The first deploy must apply schema migrations before the app can serve
real traffic:

```bash
docker compose exec fernly-1 bunx prisma migrate deploy
docker compose exec fernly-1 SEED_DEMO=0 node scripts/seed.js   # only if you want demo accounts
```

Verify with `bunx prisma migrate status` — should report
"Database schema is up to date!".

### 1.5 Seed an admin

If you didn't seed demo accounts, create a real admin via Prisma:

```bash
docker compose exec fernly-1 bunx prisma studio
# Or via psql against the Supabase pooler.
```

Insert a `User` row with `role: ADMIN` and a bcrypt-hashed password
(use the `bcrypt.hash` from the app: `node -e "console.log(require('bcrypt').hashSync('YourPassword1', 12))"`).

### 1.6 Smoke test

- Browse to `https://your-production-domain.example/` — login screen.
- Sign in as the admin.
- Verify the dashboard loads, the API discovery at `/api` works, and
  `/api/health` returns 200.

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

If a new migration ships with the deploy:

```bash
docker compose exec fernly-1 bunx prisma migrate deploy
# Then restart both replicas so they pick up the new schema.
docker compose restart fernly-1 fernly-2
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
  `{ status: "ok", db: "up", redis: "up" }`. Returns 503 if the DB is
  unreachable. Suitable for k8s probes / Docker `HEALTHCHECK` / nginx
  passive checks.
- **Logs:** `docker compose logs -f fernly-1` — structured JSON from
  the proxy middleware, plus console output from the app.
- **Sentry:** if `SENTRY_DSN` is set, uncaught server + client errors
  forward automatically.
- **Audit prune cron:** the `audit-cron` service calls
  `/api/cron/prune-audit` daily at 03:00 UTC; check its logs with
  `docker compose logs audit-cron`.

---

## 6. Common operations

| Operation | Command |
|---|---|
| Tail logs (all services) | `docker compose logs -f --tail=100` |
| Tail logs (one replica) | `docker compose logs -f fernly-1` |
| Restart one replica | `docker compose restart fernly-1` |
| Restart everything | `docker compose restart` |
| Open a shell in a replica | `docker compose exec fernly-1 /bin/sh` |
| Apply migrations | `docker compose exec fernly-1 bunx prisma migrate deploy` |
| Check migration status | `docker compose exec fernly-1 bunx prisma migrate status` |
| Inspect Redis | `docker compose exec redis redis-cli INFO` |
| Reload nginx config | `docker compose exec nginx nginx -s reload` |
| Pull an image-only update | `docker compose pull && docker compose up -d` |

---

## 7. Post-deploy checklist

- [ ] `/api/health` returns 200 with `db:up` and `redis:up`.
- [ ] Login works as the admin account.
- [ ] Login works for a MEMBER (lowest privilege).
- [ ] A non-existent email returns the same UI as a wrong password.
- [ ] Password reset email arrives within 60s (if Resend is wired).
- [ ] Audit log records `auth.signed_in` for the test login.
- [ ] `docker compose ps` shows all services Up (healthy).
- [ ] `docker compose logs --tail=200 fernly-1 fernly-2` shows no
      uncaught errors in the last 5 minutes.
