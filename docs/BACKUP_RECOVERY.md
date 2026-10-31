# Backup & Disaster Recovery Runbook

**L-P1-22** — RPO/RTO targets, restore procedures, drill schedule.

## RPO/RTO targets

| Metric | Target | Justification |
|--------|--------|---------------|
| **RPO** (Recovery Point Objective) | ≤ 5 minutes | Supabase PITR backs up WAL segments every 5 min. Worst-case data loss is 5 min of writes. |
| **RTO** (Recovery Time Objective) | ≤ 1 hour | Full restore + WAL replay <30 min for the current dataset + verification + DNS cutover. |

## Backup strategy

1. **Daily snapshots** — full backup every 24h. Retained 7 days (free) / 30 days (Pro).
2. **PITR (Point-In-Time Recovery)** — continuous WAL archiving every 5 min. Primary
   recovery mechanism for the 5-minute RPO. Requires Supabase Pro tier.

### Enablement checklist

- [ ] Confirm PITR is enabled (Dashboard → Database → Backups → PITR; Pro tier required)
- [ ] Verify the WAL archive interval is 5 min (Supabase default)
- [ ] Document the project ref in the ops runbook: `hnbvpdybdhgjsalxrqcg`
- [ ] Set up a "no recent backup" alert (Dashboard → Alerts)

## Restore procedures

### Scenario 1: Restore to a specific point in time (PITR)

1. Identify the target timestamp (BEFORE the incident).
2. Create a new Supabase project as the restore target (never restore into production directly).
3. Dashboard → Database → Backups → PITR → select timestamp → choose target project → confirm.
4. Verify the restore:
   ```sql
   SELECT COUNT(*) FROM "User" WHERE "deletedAt" IS NULL;
   SELECT COUNT(*) FROM "Task";
   SELECT COUNT(*) FROM "Project" WHERE "deletedAt" IS NULL;
   SELECT MAX("createdAt") FROM "AuditLog";
   ```
5. Cutover: update `DATABASE_URL` in production, restart app instances.
6. Document the incident (timestamp, cause, RTO achieved, data loss).

### Scenario 2: Restore from daily snapshot

Dashboard → Database → Backups → Daily snapshots → most recent → "Restore to new project" → follow steps 4–6 above.

### Scenario 3: Schema-level recovery (Prisma migrations)

1. `bun run db:status` — see which migrations are applied
2. `bunx prisma migrate resolve --rolled-back <migration_name>`
3. Manually revert the schema changes (Prisma doesn't auto-generate down migrations)
4. Verify the schema matches the previous migration's state

## Restore drill

**Schedule:** quarterly (every 3 months).

1. Create a fresh staging Supabase project.
2. Trigger a PITR restore to a timestamp 1 hour ago.
3. Time the restore from trigger to "first successful query".
4. Verify row counts match production (within the 1-hour delta).
5. Record the actual RTO in the incident log.
6. If RTO > 1 hour, investigate and document the bottleneck.

**Last drill:** _not yet executed — schedule the first drill before launch._

## Verification queries

```sql
-- Row counts
SELECT 'users' AS tbl, COUNT(*) FROM "User" WHERE "deletedAt" IS NULL
UNION ALL SELECT 'projects', COUNT(*) FROM "Project" WHERE "deletedAt" IS NULL
UNION ALL SELECT 'tasks', COUNT(*) FROM "Task"
UNION ALL SELECT 'messages', COUNT(*) FROM "Message" WHERE "deletedAt" IS NULL
UNION ALL SELECT 'audit_log', COUNT(*) FROM "AuditLog";

-- Most recent activity
SELECT MAX("createdAt") AS latest_audit FROM "AuditLog";

-- Schema integrity
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
```

## Contact

- **Supabase support:** via the Dashboard (Pro tier includes email support)
- **On-call:** see the on-call schedule in the ops wiki
- **Escalation:** if RTO is at risk, page the on-call engineer immediately
