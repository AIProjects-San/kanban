"use server";

// ---------------------------------------------------------------------------
// P7 (PR-20/PR-21, F3.3) — the gratuity rule editor actions.
// docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2.1 payroll sweep, item 7.
//
// Read + save of the workspace's ONE rule row and its slab rows. The rule
// is configuration data only: the payout line is computed into the LIVE
// full-and-final statement by lib/gratuity.ts (never here), so editing the
// rule can never move a settled statement — the freeze discipline holds
// because this file writes no money anywhere.
//
// Save semantics: one transaction — upsert the rule row, deleteMany +
// createMany the slabs (the slab set is replaced wholesale; @@unique(fromYears)
// makes duplicate starts impossible at the DB level too). Audited as
// payroll.gratuity_rule_saved with the rule's shape in the detail line.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseOrThrow } from "@/lib/validation";
import { saveGratuityRuleSchema } from "@/lib/validation";
import { validateGratuityRuleInput } from "@/lib/gratuity";
import type { GratuityRuleT } from "@/lib/types";

/** The default world before HR configures anything: off, no slabs. */
const DEFAULT_RULE: GratuityRuleT = { enabled: false, averagingMonths: 3, slabs: [] };

export async function getGratuityRule(): Promise<ActionResult<GratuityRuleT>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rule = await db.gratuityRule.findFirst();
    if (!rule) return DEFAULT_RULE;
    const slabs = await db.gratuitySlab.findMany({ orderBy: { fromYears: "asc" } });
    return {
      enabled: rule.enabled,
      averagingMonths: rule.averagingMonths,
      slabs: slabs.map((s) => ({
        id: s.id,
        fromYears: s.fromYears,
        toYears: s.toYears,
        fraction: s.fraction,
      })),
    };
  });
}

export async function saveGratuityRule(input: unknown): Promise<ActionResult<GratuityRuleT>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(saveGratuityRuleSchema, input);

    // The kernel owns the overlap/coverage rules (one tested place).
    const plan = validateGratuityRuleInput(data);
    if (!plan.ok) throw new AuthorizationError(plan.reason);

    await db.$transaction(async (tx) => {
      const existing = await tx.gratuityRule.findFirst();
      if (existing) {
        await tx.gratuityRule.update({
          where: { id: existing.id },
          data: { enabled: data.enabled, averagingMonths: data.averagingMonths },
        });
      } else {
        await tx.gratuityRule.create({
          data: { enabled: data.enabled, averagingMonths: data.averagingMonths },
        });
      }
      await tx.gratuitySlab.deleteMany({});
      if (plan.slabs.length > 0) {
        await tx.gratuitySlab.createMany({
          data: plan.slabs.map((s) => ({ fromYears: s.fromYears, toYears: s.toYears, fraction: s.fraction })),
        });
      }
    });

    await logAudit({
      actor: auth,
      action: "payroll.gratuity_rule_saved",
      entityType: "GRATUITY_RULE",
      entityId: "rule",
      entityLabel: data.enabled
        ? `${plan.slabs.length} slab(s), ${data.averagingMonths}-month averaging`
        : "disabled",
      detail: `${auth.name} saved the gratuity rule — ${data.enabled ? `enabled with ${plan.slabs.length} slab(s) over a ${data.averagingMonths}-month earnings average` : "disabled"}. The rule prices future full-and-final statements only; settled statements keep their frozen amounts.`,
    });
    revalidatePath("/");

    return {
      enabled: data.enabled,
      averagingMonths: data.averagingMonths,
      slabs: plan.slabs.map((s, i) => ({
        id: `slab-${i}`,
        fromYears: s.fromYears,
        toYears: s.toYears,
        fraction: s.fraction,
      })),
    };
  });
}
