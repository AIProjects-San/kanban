// ---------------------------------------------------------------------------
// R-P0-8 (REVIEW_TRIAGE §7, pre-check C scope addition) — one-time
// migration: redact candidate PII from legacy stored calendar events.
//
// Before R-P0-4, the interview writer stored
//   title:       `Interview: ${fullName} — ${stage.label}`
//   description: `${position} · ${email}`
// on the shared calendar. R-P0-4 fixed the writer and the ICS export; this
// script cleans the STORED rows so every reader of the title field — the
// dashboard feed (dashboard.ts:188, deliberately untouched), the calendar
// grid, future export wiring — renders PII-free data. Events are redacted,
// never deleted.
//
// Reversibility: BEFORE anything is written, the full plan (original +
// redacted values per event) is dumped to a timestamped backup file at the
// repo root — `local-event-pii-backup-<ISO>.json` (gitignored via the
// `local-*` pattern, because it CONTAINS the PII being removed). Restoring
// the `before` values from that file reverses the migration. The backup
// file must be stored per the workspace's retention policy for PII-bearing
// artifacts (secure location, destroyed when the retention window closes).
//
// Idempotent: redacted rows match none of the migration's patterns
// (fixed-point) — re-running is a no-op that reports zero redactions.
//
// Audit: every redaction writes an audit row in the same transaction
// (action `hiring.event_pii_redacted`, system actor); audit rows carry no
// PII — the entity label is the redacted title.
//
// Run: bash scripts/run-with-env.sh bun scripts/migrate-interview-event-pii.ts
// ---------------------------------------------------------------------------

import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  migrateLegacyEventPii,
  type PiiMigrationClient,
  type PiiRedactionPlanItem,
} from "../src/lib/hiring/legacy-event-pii";

const db = new PrismaClient();

async function main(): Promise<void> {
  console.log("🛡️  R-P0-8 — legacy interview-event PII migration…");

  const result = await migrateLegacyEventPii(
    db as unknown as PiiMigrationClient,
    undefined,
    {
      // The pre-migration backup: written BEFORE the transaction applies,
      // from the computed plan, so a crash between backup and apply leaves
      // the data untouched (and a crash after apply still has the backup).
      onPlan: (plan: PiiRedactionPlanItem[]) => {
        if (plan.length === 0) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = join(process.cwd(), `local-event-pii-backup-${stamp}.json`);
        writeFileSync(
          backupPath,
          JSON.stringify(
            {
              migration: "R-P0-8 legacy interview-event PII redaction",
              createdAt: new Date().toISOString(),
              note:
                "Restoring each item's `before` values reverses the migration. " +
                "This file contains the redacted PII — store per the workspace PII " +
                "retention policy and destroy when the window closes.",
              items: plan,
            },
            null,
            2,
          ),
        );
        console.log(`   backup: ${backupPath} (${plan.length} event(s))`);
      },
    },
  );

  console.log(
    `   scanned ${result.scanned} calendar event(s); redacted ${result.redacted}.` +
      (result.redacted === 0
        ? " (Idempotent re-run: nothing matched — stored titles are already PII-free.)"
        : ""),
  );
  console.log("✅ done.");
}

main()
  .catch((err) => {
    console.error("❌ migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
