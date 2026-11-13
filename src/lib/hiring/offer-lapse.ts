// F2.10 (F-R5) — lazy materialization: flip every SENT offer whose signing
// link has passed its expiry to the stored EXPIRED outcome. Idempotent (the
// where-clause only matches still-SENT rows); called at the top of the
// hiring reads (getOfferRecords / getHiringFunnel) so the DB converges on
// the honest state exactly like the F2.4 leave-allocation lazy path. The
// funnel ALSO counts awaiting through the pure predicate, so the number is
// honest even before a lapse has run.

import { db } from "@/lib/infra/db";
import { logAudit } from "@/lib/audit/audit";

/** F2.10 (F-R5) — lazy materialization: flip every SENT offer whose signing
 * link has passed its expiry to the stored EXPIRED outcome. Idempotent (the
 * where-clause only matches still-SENT rows); called at the top of the
 * hiring reads (getOfferRecords / getHiringFunnel) so the DB converges on
 * the honest state exactly like the F2.4 leave-allocation lazy path. The
 * funnel ALSO counts awaiting through the pure predicate, so the number is
 * honest even before a lapse has run. */
export async function lapseExpiredSentOffers(): Promise<number> {
  const lapsed = await db.offerRecord.updateMany({
    where: {
      status: "SENT",
      tokenExpiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  const count = lapsed.count ?? 0;
  if (count > 0) {
    await logAudit({
      actor: { userId: "system", name: "System", role: "SYSTEM" },
      action: "hiring.offers_lapsed",
      entityType: "OFFER_RECORD",
      entityLabel: `${count} offer${count === 1 ? "" : "s"}`,
      detail: `${count} sent offer${count === 1 ? "" : "s"} passed their signing-link expiry and ${count === 1 ? "was" : "were"} marked EXPIRED.`,
    });
  }
  return count;
}
