# Status Page & On-Call Runbook

**L-P2-37** — Public status page definition + written runbooks for the known
failure modes. Operational polish that lands once the L-P1-19 observability
stack is live.

## Status page

**Where:** a static page (or a hosted service — Statuspage, Instatus,
Cachet) at `status.fernly.app`, separate from the app infrastructure so an
app outage doesn't take the status page down with it.

**Components displayed:**

| Component | Probe | Source |
|-----------|-------|--------|
| Web app | `GET /` returns 2xx | external uptime monitor (UptimeRobot / Better Stack) every 60s |
| API + DB | `GET /api/health` returns 200 with `db:"up"` (L-P0-4) | same monitor, every 60s |
| Database (direct) | Supabase status feed | Supabase's own status page RSS |

**Incident severities:**

- 🟢 **Operational** — all probes green
- 🟡 **Degraded** — p95 > 3s or error rate > 1% for 5 min (from the
  structured logs, L-P1-19)
- 🔴 **Outage** — `/api/health` failing from 2+ regions for 2 min

**Communication SLA:** post a status update within 15 min of a 🔴, and every
30 min until resolved.

## On-call runbooks

### Runbook: secret rotation (BETTER_AUTH_SECRET)

**Symptom:** sessions must be invalidated wholesale (suspected key
compromise, or routine rotation).

1. Rotate the secret in the environment (`.env` / secret manager).
2. Clear the session table (`DELETE FROM "Session";` — the old rows are
   signed with the old secret and fail silent anyway, but clearing them
   keeps the table tidy).
3. Restart the app instances (`docker compose restart fernly-1`).
4. Better Auth's opaque DB-backed tokens fail silent on a secret mismatch:
   users simply see the login screen — no error spam. The proxy also
   expires obsolete pre-migration `next-auth.*` cookies on first sight.
5. Verify: sign in fresh, confirm `GET /` returns 200 and a new
   `fernly.session_token` cookie is set.
6. Post a status note if sign-in errors spiked.

**Cadence:** quarterly (calendar recurring event). Never reuse a secret.

### Runbook: database failover / outage

**Symptom:** `/api/health` returns 503 with `db:"down"` (L-P0-4); app pages
still render (the login screen) because the health endpoint isolates the DB.

1. Check the Supabase status page for a regional incident.
2. If Supabase-side: post a 🔴 status update, monitor their progress, no
   app-side action needed.
3. If credential/network issue: verify `DATABASE_URL` is reachable from the
   app instance (`psql "$DATABASE_URL" -c "SELECT 1"`).
4. Recovery path is the restore procedure in `docs/BACKUP_RECOVERY.md`
   (PITR to a point before the corruption, RTO ≤ 1 hour).
5. After recovery: `bun run db:status` to confirm migrations are in sync,
   then `/api/health` until it returns 200.

### Runbook: bad deploy

**Symptom:** error rate spikes immediately after a deployment; error
boundary page (`error.tsx`) sightings increase.

1. **Rollback first, diagnose second.** Docker: redeploy the previous image
   tag (`docker compose up -d --no-deps fernly-1` with the prior tag), or
   git-revert + redeploy.
2. Confirm recovery via `/api/health` + error rate in the structured logs.
3. Post a status update ("deploy rolled back, investigating").
4. Root-cause in a follow-up; the request-id (L-P1-19, `X-Request-Id`)
   correlates the failing requests across logs.

### Escalation

1. On-call engineer (primary) — 15 min response SLA for 🔴
2. Secondary on-call — paged if no ack in 15 min
3. Engineering lead — for anything exceeding 1 hour or requiring a data
   restore decision (RPO trade-offs in `docs/BACKUP_RECOVERY.md`)

## Follow-ups

- Hosted status page signup + domain wiring (ops task)
- Uptime monitor configuration (external, not app code)
- Alert routing from the structured logs → PagerDuty/Opsgenie (L-P1-19
  follow-up)
