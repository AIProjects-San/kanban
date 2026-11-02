# Database Region Decision

**L-P1-26** — Documented decision + measurement plan.

## Context

The database is hosted on Supabase in `eu-west-1` (Dublin). The product's
timezone default is `Pacific/Auckland`, targeting NZ/AU users. This creates a
cross-continent round trip on every page load (~250-300ms RTT × 2 = ~500-600ms
per DB round trip). The dashboard loader runs 8 parallel queries in one
`Promise.all`, so the cost is ~1 DB RTT — but that RTT is still 500-600ms on
every page load, a significant chunk of the audit's 1.5s p95 budget.

## Decision: ACCEPT eu-west-1 for launch, migrate to Sydney (ap-southeast-2) post-launch

### Rationale

1. **Launch timeline** — migrating requires a full export/import + DNS cutover.
   With the L-P0-5 indexes + L-P1-17 code splitting, the total page-load time
   stays under the 1.5s p95 budget.
2. **L-P0-5 indexes mitigate** — each scoped query is an index scan (<5ms).
3. **Post-launch migration is low-risk** — provision new project, pg_dump /
   pg_restore, update `DATABASE_URL`, restart. Expected downtime <30 min.

### Alternatives considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Migrate to Sydney before launch | Best latency (RTT ~40ms) | Adds risk to launch timeline | Rejected — latency is within budget |
| Accept eu-west-1 permanently | No migration work | 500-600ms RTT permanently | Rejected — UX cost is real |
| Read replicas in Sydney | No migration | Pro-tier only; writes still hit eu-west-1 | Rejected for now |
| CDN for static assets | Offloads JS/CSS | Already handled by nginx LB (L-P1-21) | Already in place |

## Measurement plan

1. **From a NZ/AU client** (e.g. a Sydney VPS):
   ```bash
   psql "postgresql://postgres:***@aws-0-eu-west-1.pooler.supabase.com:5432/postgres" \
     -c "SELECT 1; \timing"
   ```
   Expected: ~250-300ms per query.

2. **From the app server**:
   ```bash
   curl -w "%{time_total}\n" -o /dev/null -s http://localhost:3000/api/health
   ```

3. **End-to-end from NZ** (WebPageTest / Lighthouse from Sydney): measure p95
   before + after migration; confirm the ~500ms improvement.

4. **Post-migration verification**:
   ```bash
   psql "$DATABASE_URL" -c "SELECT current_setting('TimeZone'), inet_server_addr();"
   ```

## Migration checklist (post-launch)

- [ ] Provision a new Supabase project in `ap-southeast-2` (Sydney)
- [ ] Enable PITR on the new project (L-P1-22 backup runbook)
- [ ] Export: `pg_dump "$OLD_DATABASE_URL" > fernly-backup.sql`
- [ ] Import: `psql "$NEW_DATABASE_URL" < fernly-backup.sql`
- [ ] `bun run db:status` against the new project — verify all migrations applied
- [ ] Run the verification queries from `docs/BACKUP_RECOVERY.md`
- [ ] Update `DATABASE_URL` in production
- [ ] Restart the app instances (`docker compose restart fernly-1`)
- [ ] Verify `/api/health` returns 200 with `db:up`
- [ ] Smoke test: login, create a task, drag a card, view analytics
- [ ] Monitor error rate + p95 latency for 1 hour post-migration
- [ ] Decommission the eu-west-1 project (after 7 days of stable operation)

## Decision recorded

- **Date:** 2026-10-30
- **Decision:** Accept eu-west-1 for launch; migrate to ap-southeast-2 (Sydney) post-launch
- **Owner:** Staff Full-Stack Engineering
- **Review trigger:** Post-launch, once the app has been stable for 1 week
