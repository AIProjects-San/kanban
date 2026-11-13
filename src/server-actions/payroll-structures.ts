"use server";

// ---------------------------------------------------------------------------
// Salary structures — the payroll compensation write surface (split from
// payroll.ts, which keeps the runs/payslips/statutory core).
//
// RBAC: payroll:manage throughout — salary data is the most sensitive
// information in the workspace; MANAGERs and MEMBERs never reach it.
//
//   • SalaryStructure — the employee's standing ANNUAL components (same
//     shape as offers; lib/offer-math.ts resolves fixed / % of basic).
//     Created manually, or copied from the hire's SIGNED offer.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { db } from "@/lib/infra/db";
import { Prisma } from "@prisma/client";
import { requirePermission, AuthorizationError } from "./auth-guard";
import type { SalaryStructureT } from "@/lib/types";
import { saveSalaryStructureSchema, bulkAssignStructureSchema, parseOrThrow } from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { parseComponents, type OfferComponent } from "@/lib/offer-math";
import { parseOpeningYtd } from "@/lib/payroll/opening-ytd";

type StructureRow = {
  id: string; userId: string; components: string; notes: string;
  effectiveFrom: Date; isActive: boolean; createdAt: Date;
  maxBenefits?: number | null;
  frequency?: string | null;
  openingYtd?: unknown;
  isDefault?: boolean | null;
};

function serializeStructure(
  s: StructureRow,
  user: { name: string } | undefined,
  profile: { jobTitle: string; department: string } | undefined,
  fromOffer: boolean,
): SalaryStructureT {
  return {
    id: s.id,
    userId: s.userId,
    userName: user?.name ?? "Unknown",
    jobTitle: profile?.jobTitle ?? "",
    department: profile?.department ?? "",
    source: fromOffer ? "OFFER" : "MANUAL",
    components: parseComponents(s.components),
    notes: s.notes,
    effectiveFrom: s.effectiveFrom.toISOString(),
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
    maxBenefits: s.maxBenefits ?? 0,
    frequency: (s.frequency || "MONTHLY") as SalaryStructureT["frequency"],
    // P16 — the SSA opening YTD rows (null = none).
    openingYtd: parseOpeningYtd(s.openingYtd),
    // P23 — the workspace default package flag (pre-P23 rows read false).
    isDefault: s.isDefault ?? false,
  };
}

/** Was this structure's employee hired through the pipeline with a signed
 * offer? (Display hint "copied from offer" — resolved per user.) */
async function signedOfferUserIds(): Promise<Set<string>> {
  const rows = await db.candidate.findMany({
    where: { status: "HIRED", userId: { not: null } },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId).filter((u): u is string => !!u));
}

// ---------------------------------------------------------------------------
// Salary structures
// ---------------------------------------------------------------------------

/** All structures (newest first) + the employee context, payroll:manage. */
export async function getSalaryStructures(): Promise<ActionResult<SalaryStructureT[]>> {
  return toResult(async () => {
    await requirePermission("payroll:manage");
    const rows = await db.salaryStructure.findMany({ orderBy: { createdAt: "desc" } });
    const [users, profiles, offerUsers] = await Promise.all([
      db.user.findMany({ select: { id: true, name: true } }),
      db.employeeProfile.findMany({ select: { userId: true, jobTitle: true, department: true } }),
      signedOfferUserIds(),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    return rows.map((s) =>
      serializeStructure(
        s,
        userMap.get(s.userId),
        profileMap.get(s.userId),
        offerUsers.has(s.userId),
      ),
    );
  });
}

/** Create or revise an employee's salary structure. Saving a new ACTIVE
 * structure for a user deactivates their previous one (one active at a
 * time; history preserved with effectiveFrom). */
export async function saveSalaryStructure(input: unknown): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(saveSalaryStructureSchema, input);
    const user = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
    if (!user) throw new AuthorizationError("Employee not found.");
    if (data.components.length === 0) {
      throw new AuthorizationError("A structure needs at least one component.");
    }
    if (!data.isActive) {
      throw new AuthorizationError("Deactivate a structure by saving its replacement — history must keep an active record.");
    }
    const effectiveFrom = data.effectiveFrom
      ? new Date(`${data.effectiveFrom}T00:00:00Z`)
      : new Date();
    const effectiveDay = effectiveFrom.toISOString().slice(0, 10);

    // P16 (PR-04 duplicate guard) — one structure per employee per effective
    // date (the benchmark's SSA duplicate guard; the retire-on-revision
    // discipline already guarantees one ACTIVE, this refuses a SECOND row
    // for the same day — a revision must move the date forward, history
    // must stay addressable by date). Updates keep their own day.
    const sameDay = await db.salaryStructure.findFirst({
      where: { userId: data.userId, effectiveFrom: { gte: effectiveFrom, lt: new Date(`${effectiveDay}T23:59:59.999Z`) } },
      select: { id: true },
    });
    if (sameDay && sameDay.id !== data.id) {
      throw new AuthorizationError(
        `${user.name} already has a structure effective ${effectiveDay} — revise it or pick another effective date.`,
      );
    }

    // P16 (PR-11 component effective windows) — a structure's lines must be
    // valid ON the structure's effectiveFrom (the catalog row owns the
    // window; structures keep snapshot copies, so this check bites only at
    // write time for the NEW row). Friendly error names the row + window.
    const catalogRows = await db.salaryComponent.findMany({
      select: { code: true, effectiveFrom: true, effectiveTo: true },
    });
    const windowByCode = new Map(catalogRows.map((r) => [r.code, r]));
    for (const c of data.components) {
      const cat = windowByCode.get(c.key);
      if (!cat) continue; // unseen codes auto-register unbounded at creation
      const fromOk = !cat.effectiveFrom || cat.effectiveFrom.getTime() <= effectiveFrom.getTime();
      const toOk = !cat.effectiveTo || effectiveFrom.getTime() <= cat.effectiveTo.getTime();
      if (!fromOk || !toOk) {
        throw new AuthorizationError(
          `Component "${c.key}" is not in its catalog window (${cat.effectiveFrom ? cat.effectiveFrom.toISOString().slice(0, 10) : "—"} → ${cat.effectiveTo ? cat.effectiveTo.toISOString().slice(0, 10) : "—"}) at the structure's effective date ${effectiveDay}.`,
        );
      }
    }

    const payload = {
      userId: data.userId,
      components: JSON.stringify(data.components),
      notes: data.notes,
      effectiveFrom,
      isActive: true,
      createdById: auth.userId,
      // P5 — the flexible-benefit cap rides the structure (0 = no cap).
      ...(data.maxBenefits !== undefined ? { maxBenefits: data.maxBenefits } : {}),
      // P10 — the cadence this structure pays on (default MONTHLY).
      frequency: data.frequency,
      // P23 (PR-03) — the workspace default package flag; the wire omits
      // it to keep the stored value (the maxBenefits convention), so it is
      // only written when the caller sends it.
      ...(data.isDefault !== undefined ? { isDefault: data.isDefault } : {}),
      // P16 (PR-04) — the opening YTD rows. Absent = the key is omitted
      // entirely (update keeps the stored rows, create stores none); an
      // explicitly emptied list clears the column (DbNull — the same
      // discipline updatePayslip uses to clear lopDetail).
      ...(data.openingYtd !== undefined
        ? {
            openingYtd:
              data.openingYtd && data.openingYtd.length > 0
                ? (data.openingYtd as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
          }
        : {}),
    };
    // P23 — at most ONE default package per workspace: saving this row as
    // the default clears every other holder. The clear + write must be ONE
    // transaction (a crash between them could leave two defaults — the
    // F-R1 discipline). Retirement of the old default is NOT automatic: a
    // retired default still prefills (the flag is a package pointer, not
    // employment state); HR moves it by marking the new structure.
    const clearOtherDefaults =
      data.isDefault === true
        ? { isDefault: true as const, ...(data.id ? { id: { not: data.id } } : {}) }
        : null;
    let row: { id: string };
    if (data.id) {
      // openingYtd is absent from payload when the wire omitted it → the
      // column stays untouched (Prisma only writes given keys).
      row = clearOtherDefaults
        ? await db.$transaction(async (tx) => {
            await tx.salaryStructure.updateMany({ where: clearOtherDefaults, data: { isDefault: false } });
            return tx.salaryStructure.update({ where: { id: data.id }, data: payload });
          })
        : await db.salaryStructure.update({ where: { id: data.id }, data: payload });
    } else {
      // One ACTIVE structure per employee: retire the previous one.
      // F-R1: retire + create in ONE transaction — two separate writes could
      // leave an employee with zero ACTIVE structures between them (silently
      // dropping them from every future run). The transaction makes the
      // hand-off atomic: either the new row exists and the old one is
      // retired, or neither happened.
      row = await db.$transaction(async (tx) => {
        await tx.salaryStructure.updateMany({
          where: { userId: data.userId, isActive: true },
          data: { isActive: false },
        });
        if (clearOtherDefaults) {
          await tx.salaryStructure.updateMany({ where: clearOtherDefaults, data: { isDefault: false } });
        }
        return tx.salaryStructure.create({ data: payload });
      });
    }
    await logAudit({
      actor: auth,
      action: "payroll.structure_saved",
      entityType: "SALARY_STRUCTURE",
      entityId: row.id,
      entityLabel: user.name,
      detail: `${auth.name} ${data.id ? "revised" : "created"} the salary structure for ${user.name} (${data.components.length} components, effective ${payload.effectiveFrom.toISOString().slice(0, 10)}${data.isDefault === true ? " — now the workspace default package" : ""}).`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

/** Copy the employee's SIGNED offer components into a new ACTIVE structure —
 * the natural path right after "Mark joined" (research B: first payroll must
 * match the appointment letter). */
export async function createStructureFromOffer(input: { userId: string }): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const userId = String(input?.userId ?? "").trim();
    if (!userId) throw new AuthorizationError("An employee id is required.");
    const candidate = await db.candidate.findFirst({
      where: { userId, status: "HIRED" },
      select: { id: true, fullName: true },
    });
    if (!candidate) throw new AuthorizationError("No hired candidate links to this employee.");
    const offer = await db.offerRecord.findFirst({
      where: { candidateId: candidate.id, status: "SIGNED" },
      orderBy: { signedAt: "desc" },
    });
    if (!offer) throw new AuthorizationError("No signed offer found for this employee.");
    const components = parseComponents(offer.components);
    if (components.length === 0) throw new AuthorizationError("The signed offer has no components to copy.");

    // F1.5 — map the offer's lines through the component catalog: for codes
    // the catalog knows, the structure line takes the catalog's canonical
    // label/kind/mode (the offer snapshot keeps its own copy verbatim — the
    // appointment letter never rewrites); the AMOUNT always stays the offer's
    // actual, never the catalog's suggestion. Codes the catalog has never
    // seen are auto-registered (with the offer's sighting as the suggested
    // amount) so the catalog converges on everything actually in use — the
    // structure editor's picker then offers them next time.
    const catalogRows = await db.salaryComponent.findMany({
      select: { code: true, label: true, kind: true, mode: true, dependsOnPaymentDays: true },
    });
    const catalogByCode = new Map(catalogRows.map((r) => [r.code, r]));
    const toRegister = components.filter((c) => !catalogByCode.has(c.key));
    const mapped = components.map((c) => {
      const cat = catalogByCode.get(c.key);
      // S6 — the catalog's depends_on_payment_days rides the snapshot
      // (sparse: only false is written into the JSON).
      return cat
        ? {
            ...c,
            label: cat.label,
            kind: cat.kind as OfferComponent["kind"],
            mode: cat.mode as OfferComponent["mode"],
            ...(cat.dependsOnPaymentDays === false ? { dependsOnPaymentDays: false } : { dependsOnPaymentDays: undefined }),
          }
        : c;
    });

    // F-R1: retire + create (+ F1.5 auto-registration of unseen codes) in
    // ONE transaction — a crash between the writes could otherwise leave the
    // employee with zero ACTIVE structures, silently dropping them from
    // every future run.
    const row = await db.$transaction(async (tx) => {
      for (const c of toRegister) {
        await tx.salaryComponent.create({
          data: {
            code: c.key,
            label: c.label,
            kind: c.kind,
            mode: c.mode,
            defaultAmount: c.amount,
            // S6 — offer lines carry no exemption knowledge; new codes
            // register as payment-day scaled (the default knob).
            dependsOnPaymentDays: true,
            isActive: true,
            sortOrder: 1000,
          },
        });
      }
      await tx.salaryStructure.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      });
      return tx.salaryStructure.create({
        data: {
          userId,
          components: JSON.stringify(mapped),
          notes: `Copied from the signed offer (${offer.templateLabel || "custom"}).`,
          isActive: true,
          createdById: auth.userId,
        },
      });
    });
    await logAudit({
      actor: auth,
      action: "payroll.structure_from_offer",
      entityType: "SALARY_STRUCTURE",
      entityId: row.id,
      entityLabel: candidate.fullName,
      detail: `${auth.name} copied ${candidate.fullName}'s signed offer (${offer.templateLabel || "custom"}) into a salary structure${toRegister.length > 0 ? `, auto-registering ${toRegister.length} new component code(s): ${toRegister.map((c) => c.key).join(", ")}` : ""}.`,
    });
    revalidatePath("/");
    return { id: row.id };
  });
}

// ---------------------------------------------------------------------------
// P14 (PR-33 / PR-04) — bulk tools: the bulk structure assignment + the
// run's employee filter.
// ---------------------------------------------------------------------------

/** P14 (PR-33) — assign ONE component set to many employees at once. Each
 * employee's ACTIVE structure is replaced in their OWN transaction
 * (retire + create — the F-R1 discipline, so a crash can never leave an
 * employee with zero ACTIVE structures), with per-employee isolation: one
 * bad record never blocks the rest, the summary is loud and the counts
 * honest (the P13 pattern). Employees without an existing structure simply
 * get their first one (nothing to retire). */
export async function bulkAssignStructure(input: unknown): Promise<ActionResult<{ replaced: number; createdFresh: number; failures: Array<{ userId: string; reason: string }> }>> {
  return toResult(async () => {
    const auth = await requirePermission("payroll:manage");
    const data = parseOrThrow(bulkAssignStructureSchema, input);

    // The employees must exist (a typo'd id is a per-employee failure, not
    // a silent skip).
    const users = await db.user.findMany({
      where: { id: { in: data.userIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    const existingActive = await db.salaryStructure.findMany({
      where: { userId: { in: data.userIds }, isActive: true },
      select: { userId: true },
    });
    const hadActive = new Set(existingActive.map((s) => s.userId));

    const componentsJson = JSON.stringify(data.components);
    const effectiveFrom = data.effectiveFrom ? new Date(`${data.effectiveFrom}T00:00:00Z`) : new Date();
    const failures: Array<{ userId: string; reason: string }> = [];
    let replaced = 0;
    let createdFresh = 0;

    for (const userId of data.userIds) {
      if (!nameById.has(userId)) {
        failures.push({ userId, reason: "employee not found" });
        continue;
      }
      try {
        await db.$transaction(async (tx) => {
          if (hadActive.has(userId)) {
            await tx.salaryStructure.updateMany({
              where: { userId, isActive: true },
              data: { isActive: false },
            });
          }
          await tx.salaryStructure.create({
            data: {
              userId,
              components: componentsJson,
              notes: data.notes,
              frequency: data.frequency,
              effectiveFrom,
              isActive: true,
              createdById: auth.userId,
            },
          });
        });
        if (hadActive.has(userId)) replaced += 1;
        else createdFresh += 1;
      } catch (e) {
        failures.push({
          userId,
          reason: e instanceof Error ? e.message : "unknown error",
        });
      }
    }

    const done = replaced + createdFresh;
    if (done === 0) {
      // Nothing landed at all — refuse loudly rather than pretending.
      throw new AuthorizationError(
        `Bulk assignment created no structures — ${failures.length} failure(s): ${failures.map((f) => `${nameById.get(f.userId) ?? f.userId} (${f.reason})`).join("; ")}.`,
      );
    }

    await logAudit({
      actor: auth,
      action: "payroll.structures_bulk_assigned",
      entityType: "SALARY_STRUCTURE",
      entityId: data.userIds[0],
      entityLabel: `${done} employee(s)`,
      detail: `${auth.name} bulk-assigned a ${data.frequency.toLowerCase()} structure (${data.components.length} components) to ${done} employee(s) — ${replaced} replaced an active structure, ${createdFresh} first structure${failures.length > 0 ? `; ${failures.length} FAILED: ${failures.map((f) => `${nameById.get(f.userId) ?? f.userId} (${f.reason})`).join("; ")}` : ""}.`,
    });
    revalidatePath("/");
    return { replaced, createdFresh, failures };
  });
}
