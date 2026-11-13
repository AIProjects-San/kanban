"use server";

// ---------------------------------------------------------------------------
// NZ statutory engine — Phase 3 (super-admin admin UI) server actions.
//
// RBAC: EVERYTHING here is `statutory:manage` — SUPER_ADMIN only (the Phase
// 0 ceiling: statutory master data drives every payslip's tax lines, so it
// sits above the ADMIN+HR payroll:manage boundary).
//
// Tasks:
//   3.1  getTaxYears / saveTaxYearSlabs / simulateTax — the tax-year slab
//        editor + the annualised-gross simulator.
//   3.2  createRuleVersion / archiveTaxYear / deleteTaxYear — the versioned
//        statutory-rule admin. A "rule version" is a new StatutoryRateSet
//        cloned from a source set with ONE category changed, effective from
//        the chosen date (IRD's own bundle-change practice: rates move as
//        effective-dated sets, and locked payslips keep their snapshots).
//        Delete is blocked for sets referenced by locked runs — those are
//        the archive-only rows.
//   3.3  getComponentTaxMappings / saveComponentTaxMapping — the salary
//        component tax mapping (taxApplicable / statutoryCategory /
//        wageBaseRef), read-only for system-generated rows.
//   3.4  getAdminEmployees / getEmployeeTaxProfileAdmin /
//        saveEmployeeTaxProfile — the three-section employee tax profile
//        with the STC / casual / auto-enrolment guardrails.
//
// Wire convention: rates on every schema are PERCENT numbers (17.5); the
// actions convert to the decimals the engine and DB store (0.175).
//
// URL note: the (admin) route group is stripped from URLs — the pages live
// at /settings/tax/*, /employees and /employees/[id]/tax-profile, which is
// what the revalidatePath calls below name.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import {
  parseOrThrow,
  saveTaxYearSlabsSchema,
  simulateTaxSchema,
  createRuleVersionSchema,
  taxYearActionSchema,
  componentTaxMappingSchema,
  employeeTaxProfileSchema,
  validationError,
} from "@/lib/validation";
import { logAudit } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import type {
  EmployeeTaxProfileT,
  SalaryComponentT,
  TaxSlabRowT,
  TaxSimulateResultT,
  TaxYearAdminT,
} from "@/lib/types";
import { NzStatutoryError, type NzPayFrequency } from "@/lib/payroll/nz/types";
import { calculatePaye } from "@/lib/payroll/nz/paye";
import { autoEnrolDueDate } from "@/lib/payroll/nz/kiwisaver";
import { resolveNzRateSet } from "@/lib/payroll/nz/calculate";
import { dec, isoDay, pct, splitTaxCode, utcMidnight, isValidIrdNumber } from "@/lib/tax-profile-preview";
import { SECONDARY_RATE_CODES } from "@/lib/payroll/nz/tax-codes";
import { RATE_SET_INCLUDE } from "@/lib/payroll/nz/calculate";

// ---------------------------------------------------------------------------
// Task 3.1 — tax years (the StatutoryRateSet family as the editor sees it).
// ---------------------------------------------------------------------------



type RateSetRow = Prisma.StatutoryRuleGetPayload<{ include: typeof RATE_SET_INCLUDE }>;

async function loadRateSet(id: string): Promise<RateSetRow | null> {
  return db.statutoryRule.findUnique({ where: { id }, include: RATE_SET_INCLUDE });
}

/** Locked-run counts per rate-set id (the Task 3.2 archive-only guard). */
async function lockedRunCounts(setIds: string[]): Promise<Map<string, number>> {
  if (setIds.length === 0) return new Map();
  const rows = await db.payrollRun.groupBy({
    by: ["rateSetId"],
    where: { rateSetId: { in: setIds }, status: "LOCKED" },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.rateSetId, r._count._all]));
}

function serializeRateSet(row: RateSetRow, lockedCount: number): TaxYearAdminT {
  const slabs: TaxSlabRowT[] = [
    ...row.payeTiers.map((t) => ({
      id: t.id,
      group: "PAYE" as const,
      code: "M/ME",
      label: `Income tax ${t.fromAnnual.toLocaleString()}–${t.toAnnual == null ? "above" : t.toAnnual.toLocaleString()}`,
      lower: t.fromAnnual,
      upper: t.toAnnual,
      rate: pct(t.rate) ?? 0,
      accInclusive: false, // primary slabs never carry the levy
      order: t.sortOrder,
    })),
    ...row.secondaryRates.map((s) => ({
      id: s.id,
      group: "SECONDARY" as const,
      code: s.code,
      label: s.label,
      lower: null,
      upper: null,
      rate: pct(s.rate) ?? 0,
      accInclusive: s.accInclusive,
      order: 0,
    })),
    ...row.esctTiers.map((t) => ({
      id: t.id,
      group: "ESCT" as const,
      code: "ESCT",
      label: `ESCT ${t.fromAnnual.toLocaleString()}–${t.toAnnual == null ? "above" : t.toAnnual.toLocaleString()}`,
      lower: t.fromAnnual,
      upper: t.toAnnual,
      rate: pct(t.rate) ?? 0,
      accInclusive: false,
      order: t.sortOrder,
    })),
  ];
  return {
    id: row.id,
    label: row.label,
    effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo: isoDay(row.effectiveTo),
    isCurrent: row.isCurrent,
    notes: row.notes,
    slabs,
    params: {
      acc: row.accLevy
        ? {
            rate: pct(row.accLevy.rate) ?? 0,
            maxEarnings: row.accLevy.maxEarnings,
            maxLevy: row.accLevy.maxLevy,
          }
        : null,
      ietc: row.ietc
        ? {
            annualAmount: row.ietc.annualAmount,
            lowerBound: row.ietc.lowerBound,
            abateFrom: row.ietc.abateFrom,
            upperBound: row.ietc.upperBound,
            abateRate: pct(row.ietc.abateRate) ?? 0,
          }
        : null,
      kiwiSaver: row.kiwiSaver
        ? {
            defaultEmployeeRate: pct(row.kiwiSaver.defaultEmployeeRate) ?? 0,
            allowedEmployeeRates: Array.isArray(row.kiwiSaver.allowedEmployeeRates)
              ? (row.kiwiSaver.allowedEmployeeRates as number[]).map((r) => Number(r))
              : [],
            employerRate: pct(row.kiwiSaver.employerRate) ?? 0,
          }
        : null,
      studentLoan: row.studentLoan
        ? { rate: pct(row.studentLoan.rate) ?? 0, annualThreshold: row.studentLoan.annualThreshold }
        : null,
    },
    lockedRunCount: lockedCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every tax year, newest first, with locked-run reference counts. */
export async function getTaxYears(): Promise<ActionResult<TaxYearAdminT[]>> {
  return toResult(async () => {
    await requirePermission("statutory:manage");
    const rows = await db.statutoryRule.findMany({
      orderBy: { effectiveFrom: "desc" },
      include: RATE_SET_INCLUDE,
    });
    const locked = await lockedRunCounts(rows.map((r) => r.id));
    return rows.map((r) => serializeRateSet(r, locked.get(r.id) ?? 0));
  });
}

// ---------------------------------------------------------------------------
// Slab validation (shared by 3.1's direct save and 3.2's versioned save).
// ---------------------------------------------------------------------------

const CANONICAL_SECONDARY = [...SECONDARY_RATE_CODES, "ND"];

/** Accepts both stored rows (id required) and zod-parsed input (id optional). */
type SlabRowInput = Omit<TaxSlabRowT, "id"> & { id?: string };

function validateSlabs(slabs: SlabRowInput[], group: "PAYE" | "SECONDARY" | "ESCT"): void {
  const rows = slabs.filter((s) => s.group === group);
  if (rows.length === 0) {
    throw validationError(`The ${group} table needs at least one row.`);
  }
  if (group === "SECONDARY") {
    const codes = rows.map((r) => r.code.trim().toUpperCase());
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    if (dupes.length > 0) {
      throw validationError(`Duplicate secondary code(s): ${[...new Set(dupes)].join(", ")}.`);
    }
    const missing = CANONICAL_SECONDARY.filter((c) => !codes.includes(c));
    if (missing.length > 0) {
      throw validationError(
        `The secondary table must keep the six IRD codes — missing: ${missing.join(", ")}.`,
      );
    }
    for (const r of rows) {
      if (r.rate <= 0 || r.rate > 100) {
        throw validationError(`Secondary code ${r.code}: the rate must be within (0, 100] percent.`);
      }
    }
    return;
  }
  // Banded tables (PAYE / ESCT): contiguous, first from 0, open top.
  const sorted = [...rows].sort((a, b) => (a.lower ?? 0) - (b.lower ?? 0));
  if (sorted[0].lower !== 0) {
    throw validationError(`The ${group} table must start at $0 (the first tier's lower bound).`);
  }
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.rate <= 0 || r.rate > 100) {
      throw validationError(`${group} tier ${i + 1}: the rate must be within (0, 100] percent.`);
    }
    if (r.upper != null && r.lower != null && r.upper <= r.lower) {
      throw validationError(`${group} tier ${i + 1}: the upper bound must exceed the lower bound.`);
    }
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      if (r.upper == null || next.lower !== r.upper) {
        throw validationError(
          `${group} tiers must be contiguous — tier ${i + 1}'s upper bound (${r.upper ?? "open"}) must equal tier ${i + 2}'s lower bound (${next.lower ?? "—"}).`,
        );
      }
    }
  }
  if (sorted[sorted.length - 1].upper != null) {
    throw validationError(`The top ${group} tier must be open-ended (no upper bound).`);
  }
}

// ---------------------------------------------------------------------------
// Task 3.1 — save one tax year's slabs directly (only when no locked run
// references the set; a referenced set must go through createRuleVersion).
// ---------------------------------------------------------------------------

export async function saveTaxYearSlabs(input: unknown): Promise<ActionResult<{ setId: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("statutory:manage");
    const data = parseOrThrow(saveTaxYearSlabsSchema, input);

    const set = await loadRateSet(data.setId);
    if (!set) throw new AuthorizationError("Tax year not found.");

    const locked = await lockedRunCounts([set.id]);
    const lockedCount = locked.get(set.id) ?? 0;
    if (lockedCount > 0) {
      throw new AuthorizationError(
        `This tax year is referenced by ${lockedCount} locked payroll run${lockedCount === 1 ? "" : "s"} — locked payslips must keep their rate tables. Create a new version (Statutory rules) instead.`,
      );
    }

    // Shape validation before anything touches the database.
    validateSlabs(data.slabs, "PAYE");
    validateSlabs(data.slabs, "SECONDARY");
    validateSlabs(data.slabs, "ESCT");
    if (!data.acc) {
      throw validationError("The ACC earners' levy parameters are required (the engine cannot run without them).");
    }

    const payeRows = data.slabs.filter((s) => s.group === "PAYE").sort((a, b) => a.order - b.order);
    const secondaryRows = data.slabs.filter((s) => s.group === "SECONDARY");
    const esctRows = data.slabs.filter((s) => s.group === "ESCT").sort((a, b) => a.order - b.order);

    await db.$transaction(async (tx) => {
      await tx.taxSlab.deleteMany({ where: { setId: set.id } });
      await tx.statutorySecondaryRate.deleteMany({ where: { setId: set.id } });
      await tx.statutoryEsctTier.deleteMany({ where: { setId: set.id } });
      await tx.statutoryAccLevy.deleteMany({ where: { setId: set.id } });
      await tx.statutoryIetc.deleteMany({ where: { setId: set.id } });
      await tx.statutoryKiwiSaver.deleteMany({ where: { setId: set.id } });
      await tx.statutoryStudentLoan.deleteMany({ where: { setId: set.id } });

      await tx.taxSlab.createMany({
        data: payeRows.map((r) => ({
          setId: set.id,
          fromAnnual: r.lower ?? 0,
          toAnnual: r.upper,
          rate: dec(r.rate),
          sortOrder: r.order,
        })),
      });
      await tx.statutorySecondaryRate.createMany({
        data: secondaryRows.map((r) => ({
          setId: set.id,
          code: r.code.trim().toUpperCase(),
          rate: dec(r.rate),
          label: r.label,
          accInclusive: r.accInclusive,
        })),
      });
      await tx.statutoryEsctTier.createMany({
        data: esctRows.map((r) => ({
          setId: set.id,
          fromAnnual: r.lower ?? 0,
          toAnnual: r.upper,
          rate: dec(r.rate),
          sortOrder: r.order,
        })),
      });
      await tx.statutoryAccLevy.create({
        data: {
          setId: set.id,
          rate: dec(data.acc!.rate),
          maxEarnings: data.acc!.maxEarnings,
          maxLevy: data.acc!.maxLevy,
        },
      });
      if (data.ietc) {
        await tx.statutoryIetc.create({
          data: {
            setId: set.id,
            annualAmount: data.ietc.annualAmount,
            lowerBound: data.ietc.lowerBound,
            abateFrom: data.ietc.abateFrom,
            upperBound: data.ietc.upperBound,
            abateRate: dec(data.ietc.abateRate),
          },
        });
      }
      if (data.kiwiSaver) {
        await tx.statutoryKiwiSaver.create({
          data: {
            setId: set.id,
            defaultEmployeeRate: dec(data.kiwiSaver.defaultEmployeeRate),
            allowedEmployeeRates: data.kiwiSaver.allowedEmployeeRates,
            employerRate: dec(data.kiwiSaver.employerRate),
          },
        });
      }
      if (data.studentLoan) {
        await tx.statutoryStudentLoan.create({
          data: {
            setId: set.id,
            rate: dec(data.studentLoan.rate),
            annualThreshold: data.studentLoan.annualThreshold,
          },
        });
      }
      await tx.statutoryRule.update({
        where: { id: set.id },
        data: { notes: data.notes },
      });
    });

    await logAudit({
      actor: auth,
      action: "statutory.rate_set_updated",
      entityType: "STATUTORY_RATE_SET",
      entityId: set.id,
      entityLabel: set.label,
      detail: `${auth.name} edited the tax year "${set.label}" in place — PAYE ${payeRows.length} tiers, ${secondaryRows.length} secondary codes, ESCT ${esctRows.length} tiers${data.acc ? `, ACC ${data.acc.rate}% cap $${data.acc.maxEarnings.toLocaleString()}` : ""}. No locked run references this set.`,
    });
    revalidatePath("/settings/tax/slabs");
    revalidatePath("/settings/tax/rules");
    return { setId: set.id };
  });
}

// ---------------------------------------------------------------------------
// Task 3.1 — the Simulate button: annualised (or period) gross → tax + ACC
// through the SAVED set (unsaved edits are not simulated).
// ---------------------------------------------------------------------------

export async function simulateTax(input: unknown): Promise<ActionResult<TaxSimulateResultT>> {
  return toResult(async () => {
    await requirePermission("statutory:manage");
    const data = parseOrThrow(simulateTaxSchema, input);

    const rateSet = await resolveNzRateSet(new Date(), data.rateSetId);
    if (!rateSet) {
      throw new AuthorizationError("Tax year not found.");
    }

    // A synthetic profile for the chosen code — the simulator answers
    // "what would the engine take?", so the KiwiSaver election facts are
    // the neutral defaults (the preview covers PAYE + ACC + student loan
    // codes only).
    const taxCode = data.studentLoan ? `${data.code} SL` : data.code;
    try {
      const r = calculatePaye({
        gross: data.gross,
        frequency: data.frequency as NzPayFrequency,
        taxProfile: {
          taxCode,
          isCasual: false,
          employmentCategory: "PERMANENT",
          employmentStartDate: null,
          casualHolidayPayInWages: true,
          kiwiSaverStatus: "ACTIVE",
          kiwiSaverRate: null,
          employerKiwiSaverRate: null,
          esctRateOverride: null,
          taxCodeSpecialRate: data.stcCertificateRate == null ? null : dec(data.stcCertificateRate),
          stcAccTreatment: data.stcAccTreatment,
          stcStudentLoanRate: null,
          stcStudentLoanThresholdApplies: true,
        },
        payeTiers: rateSet.payeTiers,
        secondaryRates: rateSet.secondaryRates,
        accLevy: rateSet.accLevy,
        ietc: rateSet.ietc,
      });
      return {
        tax: r.tax,
        acc: r.acc,
        total: r.total,
        method: r.method,
        ietc: r.ietc,
        annualised: r.annualised,
        rateSetLabel: rateSet.label,
        ruleVersion: "",
      };
    } catch (e) {
      if (e instanceof NzStatutoryError) {
        // The engine's own guardrail messages are user-facing (e.g. the
        // STC-without-certificate case) — surface them as validation.
        throw validationError(e.message);
      }
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// Task 3.2 — versioned statutory rules.
// ---------------------------------------------------------------------------

export async function createRuleVersion(
  input: unknown,
): Promise<ActionResult<{ setId: string; label: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("statutory:manage");
    const data = parseOrThrow(createRuleVersionSchema, input);

    const source = await loadRateSet(data.sourceSetId);
    if (!source) throw new AuthorizationError("Source tax year not found.");

    const newFrom = utcMidnight(data.effectiveFrom);
    const now = new Date();
    if (newFrom.getTime() <= source.effectiveFrom.getTime()) {
      throw validationError(
        `The new version's effective date must be after the source set's (${source.effectiveFrom.toISOString().slice(0, 10)}).`,
      );
    }
    if (source.effectiveTo && newFrom.getTime() >= source.effectiveTo.getTime()) {
      throw validationError(
        `The new version's effective date must fall inside the source set's window (before ${source.effectiveTo.toISOString().slice(0, 10)}).`,
      );
    }
    // No other set may start between the source's start and the new date —
    // the new version splits the source's window and must not overlap it.
    const colliding = await db.statutoryRule.findFirst({
      where: {
        id: { not: source.id },
        effectiveFrom: { gt: source.effectiveFrom, lte: newFrom },
      },
      select: { label: true, effectiveFrom: true },
    });
    if (colliding) {
      throw validationError(
        `"${colliding.label}" already starts on ${colliding.effectiveFrom.toISOString().slice(0, 10)} — the new version's effective date must precede it.`,
      );
    }
    const labelTaken = await db.statutoryRule.findUnique({ where: { label: data.label } });
    if (labelTaken) {
      throw validationError(`A tax year labelled "${data.label}" already exists.`);
    }

    // Category validation.
    const v = data.values;
    const wantSlabs = data.category === "PAYE" || data.category === "SECONDARY" || data.category === "ESCT";
    if (wantSlabs && !v.slabs) {
      throw validationError(`The ${data.category} category needs its rows.`);
    }
    if (wantSlabs && v.slabs) {
      validateSlabs(v.slabs, data.category as "PAYE" | "SECONDARY" | "ESCT");
    }
    if (data.category === "ACC" && !v.acc) {
      throw validationError("The ACC levy parameters are required.");
    }
    if (data.category === "IETC" && !v.ietc) {
      throw validationError("The IETC parameters are required.");
    }
    if (data.category === "KIWISAVER" && !v.kiwiSaver) {
      throw validationError("The KiwiSaver parameters are required.");
    }
    if (data.category === "STUDENT_LOAN" && !v.studentLoan) {
      throw validationError("The student loan parameters are required.");
    }

    const newId = await db.$transaction(async (tx) => {
      // The new set inherits the rest of the source's window.
      const created = await tx.statutoryRule.create({
        data: {
          label: data.label,
          country: source.country,
          effectiveFrom: newFrom,
          effectiveTo: source.effectiveTo,
          isCurrent: newFrom.getTime() <= now.getTime(),
          notes: data.notes || `Versioned from "${source.label}" (${data.category} changed).`,
          createdById: auth.userId,
        },
      });

      // Clone every untouched category…
      if (data.category !== "PAYE" && source.payeTiers.length > 0) {
        await tx.taxSlab.createMany({
          data: source.payeTiers.map((t) => ({
            setId: created.id, fromAnnual: t.fromAnnual, toAnnual: t.toAnnual, rate: t.rate, sortOrder: t.sortOrder,
          })),
        });
      }
      if (data.category !== "SECONDARY" && source.secondaryRates.length > 0) {
        await tx.statutorySecondaryRate.createMany({
          data: source.secondaryRates.map((s) => ({
            setId: created.id, code: s.code, rate: s.rate, label: s.label, accInclusive: s.accInclusive,
          })),
        });
      }
      if (data.category !== "ESCT" && source.esctTiers.length > 0) {
        await tx.statutoryEsctTier.createMany({
          data: source.esctTiers.map((t) => ({
            setId: created.id, fromAnnual: t.fromAnnual, toAnnual: t.toAnnual, rate: t.rate, sortOrder: t.sortOrder,
          })),
        });
      }
      if (data.category !== "ACC" && source.accLevy) {
        await tx.statutoryAccLevy.create({
          data: {
            setId: created.id,
            rate: source.accLevy.rate,
            maxEarnings: source.accLevy.maxEarnings,
            maxLevy: source.accLevy.maxLevy,
          },
        });
      }
      if (data.category !== "IETC" && source.ietc) {
        await tx.statutoryIetc.create({
          data: {
            setId: created.id,
            annualAmount: source.ietc.annualAmount,
            lowerBound: source.ietc.lowerBound,
            abateFrom: source.ietc.abateFrom,
            upperBound: source.ietc.upperBound,
            abateRate: source.ietc.abateRate,
          },
        });
      }
      if (data.category !== "KIWISAVER" && source.kiwiSaver) {
        await tx.statutoryKiwiSaver.create({
          data: {
            setId: created.id,
            defaultEmployeeRate: source.kiwiSaver.defaultEmployeeRate,
            allowedEmployeeRates: source.kiwiSaver.allowedEmployeeRates as number[],
            employerRate: source.kiwiSaver.employerRate,
          },
        });
      }
      if (data.category !== "STUDENT_LOAN" && source.studentLoan) {
        await tx.statutoryStudentLoan.create({
          data: {
            setId: created.id,
            rate: source.studentLoan.rate,
            annualThreshold: source.studentLoan.annualThreshold,
          },
        });
      }

      // …and write the edited category from the submitted values.
      if (data.category === "PAYE" && v.slabs) {
        const rows = v.slabs.filter((s) => s.group === "PAYE").sort((a, b) => a.order - b.order);
        await tx.taxSlab.createMany({
          data: rows.map((r) => ({
            setId: created.id, fromAnnual: r.lower ?? 0, toAnnual: r.upper, rate: dec(r.rate), sortOrder: r.order,
          })),
        });
      }
      if (data.category === "SECONDARY" && v.slabs) {
        const rows = v.slabs.filter((s) => s.group === "SECONDARY");
        await tx.statutorySecondaryRate.createMany({
          data: rows.map((r) => ({
            setId: created.id, code: r.code.trim().toUpperCase(), rate: dec(r.rate), label: r.label, accInclusive: r.accInclusive,
          })),
        });
      }
      if (data.category === "ESCT" && v.slabs) {
        const rows = v.slabs.filter((s) => s.group === "ESCT").sort((a, b) => a.order - b.order);
        await tx.statutoryEsctTier.createMany({
          data: rows.map((r) => ({
            setId: created.id, fromAnnual: r.lower ?? 0, toAnnual: r.upper, rate: dec(r.rate), sortOrder: r.order,
          })),
        });
      }
      if (data.category === "ACC" && v.acc) {
        await tx.statutoryAccLevy.create({
          data: { setId: created.id, rate: dec(v.acc.rate), maxEarnings: v.acc.maxEarnings, maxLevy: v.acc.maxLevy },
        });
      }
      if (data.category === "IETC" && v.ietc) {
        await tx.statutoryIetc.create({
          data: {
            setId: created.id,
            annualAmount: v.ietc.annualAmount,
            lowerBound: v.ietc.lowerBound,
            abateFrom: v.ietc.abateFrom,
            upperBound: v.ietc.upperBound,
            abateRate: dec(v.ietc.abateRate),
          },
        });
      }
      if (data.category === "KIWISAVER" && v.kiwiSaver) {
        await tx.statutoryKiwiSaver.create({
          data: {
            setId: created.id,
            defaultEmployeeRate: dec(v.kiwiSaver.defaultEmployeeRate),
            allowedEmployeeRates: v.kiwiSaver.allowedEmployeeRates,
            employerRate: dec(v.kiwiSaver.employerRate),
          },
        });
      }
      if (data.category === "STUDENT_LOAN" && v.studentLoan) {
        await tx.statutoryStudentLoan.create({
          data: { setId: created.id, rate: dec(v.studentLoan.rate), annualThreshold: v.studentLoan.annualThreshold },
        });
      }

      // Close the source set's window at the new date.
      await tx.statutoryRule.update({
        where: { id: source.id },
        data: { effectiveTo: newFrom, isCurrent: source.effectiveFrom.getTime() <= now.getTime() },
      });
      return created.id;
    });

    await logAudit({
      actor: auth,
      action: "statutory.rate_set_version_created",
      entityType: "STATUTORY_RATE_SET",
      entityId: newId,
      entityLabel: data.label,
      detail: `${auth.name} created a new ${data.category} rule version "${data.label}" effective ${data.effectiveFrom}, versioned from "${source.label}" (its window now closes on ${data.effectiveFrom}).`,
    });
    revalidatePath("/settings/tax/slabs");
    revalidatePath("/settings/tax/rules");
    return { setId: newId, label: data.label };
  });
}

/** Retire a set from the resolution chain (effectiveTo = today). Refused
 * when no other set would cover today — that would break future runs. */
export async function archiveTaxYear(input: unknown): Promise<ActionResult<{ setId: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("statutory:manage");
    const data = parseOrThrow(taxYearActionSchema, input);
    const set = await db.statutoryRule.findUnique({ where: { id: data.setId } });
    if (!set) throw new AuthorizationError("Tax year not found.");

    const now = new Date();
    const coversNow = await db.statutoryRule.findFirst({
      where: {
        id: { not: set.id },
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      select: { id: true },
    });
    if (!coversNow) {
      throw new AuthorizationError(
        "Archiving this tax year would leave no rate set covering today — create a new version first (Statutory rules → New version).",
      );
    }

    await db.statutoryRule.update({
      where: { id: set.id },
      data: { effectiveTo: now, isCurrent: false },
    });
    await logAudit({
      actor: auth,
      action: "statutory.rate_set_archived",
      entityType: "STATUTORY_RATE_SET",
      entityId: set.id,
      entityLabel: set.label,
      detail: `${auth.name} archived the tax year "${set.label}" — its window now closes on ${now.toISOString().slice(0, 10)}.`,
    });
    revalidatePath("/settings/tax/slabs");
    revalidatePath("/settings/tax/rules");
    return { setId: set.id };
  });
}

/** Hard-delete an unreferenced set. Task 3.2's archive-only guard: a set
 * referenced by any LOCKED payroll run can never be deleted. */
export async function deleteTaxYear(input: unknown): Promise<ActionResult<{ setId: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("statutory:manage");
    const data = parseOrThrow(taxYearActionSchema, input);
    const set = await db.statutoryRule.findUnique({ where: { id: data.setId } });
    if (!set) throw new AuthorizationError("Tax year not found.");

    const locked = await lockedRunCounts([set.id]);
    const lockedCount = locked.get(set.id) ?? 0;
    if (lockedCount > 0) {
      throw new AuthorizationError(
        `"${set.label}" is referenced by ${lockedCount} locked payroll run${lockedCount === 1 ? "" : "s"} — locked payslips must keep their rate tables. Archive it instead.`,
      );
    }
    const openRefs = await db.payrollRun.count({
      where: { rateSetId: set.id, status: { not: "LOCKED" } },
    });

    await db.statutoryRule.delete({ where: { id: set.id } });
    await logAudit({
      actor: auth,
      action: "statutory.rate_set_deleted",
      entityType: "STATUTORY_RATE_SET",
      entityId: set.id,
      entityLabel: set.label,
      detail: `${auth.name} deleted the tax year "${set.label}" (${openRefs} open run reference${openRefs === 1 ? "" : "s"} went with it; no locked run referenced the set).`,
    });
    revalidatePath("/settings/tax/slabs");
    revalidatePath("/settings/tax/rules");
    return { setId: set.id };
  });
}

// ---------------------------------------------------------------------------
// Task 3.3 — component tax mapping.
// ---------------------------------------------------------------------------

function serializeComponent(r: {
  id: string; code: string; label: string; kind: string; mode: string;
  defaultAmount: number; dependsOnPaymentDays: boolean;
  effectiveFrom: Date | null; effectiveTo: Date | null;
  isActive: boolean; sortOrder: number;
  taxApplicable: boolean; statutoryCategory: string; wageBaseRef: string;
  isSystemGenerated: boolean; createdAt: Date;
}): SalaryComponentT {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    kind: r.kind as SalaryComponentT["kind"],
    mode: r.mode as SalaryComponentT["mode"],
    defaultAmount: r.defaultAmount,
    dependsOnPaymentDays: r.dependsOnPaymentDays,
    effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString().slice(0, 10) : null,
    effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
    isActive: r.isActive,
    sortOrder: r.sortOrder,
    taxApplicable: r.taxApplicable,
    statutoryCategory: r.statutoryCategory as SalaryComponentT["statutoryCategory"],
    wageBaseRef: r.wageBaseRef as SalaryComponentT["wageBaseRef"],
    isSystemGenerated: r.isSystemGenerated,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Active SalaryComponents with their tax mapping. */
export async function getComponentTaxMappings(): Promise<ActionResult<SalaryComponentT[]>> {
  return toResult(async () => {
    await requirePermission("statutory:manage");
    const rows = await db.salaryComponent.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    });
    return rows.map(serializeComponent);
  });
}

/** Inline-edit one component's mapping. System-generated rows are
 * read-only (the seed / engine owns them). */
export async function saveComponentTaxMapping(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return toResult(async () => {
    const auth = await requirePermission("statutory:manage");
    const data = parseOrThrow(componentTaxMappingSchema, input);

    const existing = await db.salaryComponent.findUnique({ where: { id: data.id } });
    if (!existing) throw new AuthorizationError("Component not found.");
    if (existing.isSystemGenerated) {
      throw new AuthorizationError(
        `The row "${existing.code}" is system-generated — its tax mapping is read-only.`,
      );
    }

    // Consistency guardrails (the engine has one gross; contradictory
    // mappings would silently mis-tax).
    if (data.taxApplicable && data.statutoryCategory === "NON_TAXABLE") {
      throw validationError("A tax-applicable component cannot be classified NON_TAXABLE.");
    }
    if (!data.taxApplicable && data.statutoryCategory === "TAXABLE_EARNING") {
      throw validationError("A component classified TAXABLE_EARNING must be tax-applicable.");
    }
    if (data.taxApplicable && data.wageBaseRef === "NONE") {
      throw validationError("A tax-applicable component must feed the GROSS wage base.");
    }

    await db.salaryComponent.update({
      where: { id: existing.id },
      data: {
        taxApplicable: data.taxApplicable,
        statutoryCategory: data.statutoryCategory,
        wageBaseRef: data.wageBaseRef,
      },
    });
    await logAudit({
      actor: auth,
      action: "tax.component_mapping_updated",
      entityType: "SALARY_COMPONENT",
      entityId: existing.id,
      entityLabel: `${existing.code} (${existing.label})`,
      detail: `${auth.name} set the tax mapping for ${existing.code} — ${existing.label}: ${data.taxApplicable ? "tax-applicable" : "not tax-applicable"}, ${data.statutoryCategory}, wage base ${data.wageBaseRef}.`,
    });
    revalidatePath("/settings/tax/component-mapping");
    return { id: existing.id };
  });
}

// ---------------------------------------------------------------------------
// Task 3.4 — employee tax profiles.
// ---------------------------------------------------------------------------

/** The employee index for the admin profile editor. */
export async function getAdminEmployees(): Promise<
  ActionResult<
    Array<{
      userId: string;
      name: string;
      email: string;
      role: string;
      taxCode: string;
      employmentType: string;
      hasProfile: boolean;
    }>
  >
> {
  return toResult(async () => {
    await requirePermission("statutory:manage");
    const users = await db.user.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    });
    // EmployeeTaxProfile has no Prisma relation to User (Phase 0 kept it a
    // plain unique column) — join in memory.
    const profiles = await db.employeeTaxProfile.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { userId: true, taxCode: true, employmentType: true },
    });
    const byUser = new Map(profiles.map((p) => [p.userId, p]));
    return users.map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      taxCode: byUser.get(u.id)?.taxCode ?? "",
      employmentType: byUser.get(u.id)?.employmentType ?? "",
      hasProfile: byUser.has(u.id),
    }));
  });
}

/** One employee's tax profile for the three-section editor (defaults when
 * no row exists yet), plus the current rate set's KiwiSaver options. */
export async function getEmployeeTaxProfileAdmin(
  userId: string,
): Promise<ActionResult<EmployeeTaxProfileT>> {
  return toResult(async () => {
    await requirePermission("statutory:manage");
    const user = await db.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    if (!user) throw new AuthorizationError("Employee not found.");

    const profile = await db.employeeTaxProfile.findUnique({ where: { userId } });
    const rateSet = await resolveNzRateSet(new Date());

    const { base, studentLoan } = profile
      ? splitTaxCode(profile.taxCode)
      : { base: "M", studentLoan: false };
    return {
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      exists: profile != null,
      irdNumber: profile?.irdNumber ?? "",
      taxCodeBase: base,
      studentLoan,
      taxCodeEffectiveFrom: isoDay(profile?.taxCodeEffectiveFrom) ?? "",
      stcCertificateRate: pct(profile ? Number(profile.taxCodeSpecialRate) : null),
      stcAccTreatment: (profile?.stcAccTreatment?.toUpperCase() as "INC" | "PLUS") ?? "INC",
      stcStudentLoanRate: pct(profile ? Number(profile.stcStudentLoanRate) : null),
      stcCertificateExpiry: isoDay(profile?.stcCertificateExpiry) ?? "",
      kiwiSaverStatus: (profile?.kiwiSaverStatus ?? "ACTIVE") as EmployeeTaxProfileT["kiwiSaverStatus"],
      kiwiSaverEmployeeRate: pct(profile ? Number(profile.kiwiSaverEmployeeRate) : null),
      kiwiSaverEmployerRate: pct(profile ? Number(profile.kiwiSaverEmployerRate) : null),
      esctRateOverride: pct(profile ? Number(profile.esctRateOverride) : null),
      employmentType: (profile?.employmentType ??
        (profile?.isCasual ? "CASUAL" : "PERMANENT")) as EmployeeTaxProfileT["employmentType"],
      casualHolidayPayInWages: profile?.casualHolidayPayInWages ?? true,
      employmentStartDate: isoDay(profile?.employmentStartDate) ?? "",
      employmentEndDate: isoDay(profile?.employmentEndDate) ?? "",
      notes: profile?.notes ?? "",
      allowedEmployeeRates: rateSet?.kiwiSaver?.allowedEmployeeRates ?? [3, 3.5, 4, 6, 8, 10],
      defaultEmployeeRate: pct(rateSet?.kiwiSaver?.defaultEmployeeRate ?? 0.035) ?? 3.5,
      employerRate: pct(rateSet?.kiwiSaver?.employerRate ?? 0.035) ?? 3.5,
    };
  });
}

/** Save the three-section profile (Task 3.4-r1). Guardrails:
 *   • STC without a certificate rate is BLOCKED (exact spec message).
 *   • Casual without holiday-pay-in-wages SAVES with the spec warning.
 *   • TEMPORARY → PERMANENT past the 28-day rule writes the REQUIRED
 *     auto-enrolment audit entry alongside the normal profile audit. */
export async function saveEmployeeTaxProfile(
  input: unknown,
): Promise<ActionResult<{ userId: string; warnings: string[] }>> {
  return toResult(async () => {
    const auth = await requirePermission("statutory:manage");
    const data = parseOrThrow(employeeTaxProfileSchema, input);

    const user = await db.user.findUnique({
      where: { id: data.userId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!user) throw new AuthorizationError("Employee not found.");

    const existing = await db.employeeTaxProfile.findUnique({ where: { userId: user.id } });

    // ---- Guardrail 1: STC requires the IR23 certificate rate. ----
    if (data.taxCodeBase === "STC" && data.stcCertificateRate == null) {
      throw validationError(
        "STC requires a tailored rate from the IR23 certificate — no default exists.",
      );
    }

    // ---- IRD number checksum (empty = not recorded). ----
    const irdDigits = data.irdNumber.replace(/\D/g, "");
    if (data.irdNumber.trim().length > 0 && !isValidIrdNumber(irdDigits)) {
      throw validationError(
        `"${data.irdNumber}" is not a valid IRD number — it needs 8–9 digits with a correct mod-11 check digit.`,
      );
    }

    // ---- KiwiSaver employee rate membership (3% stays legal only for
    //      pre-existing elections — an unchanged stored rate passes). ----
    if (data.kiwiSaverEmployeeRate != null) {
      const rateSet = await resolveNzRateSet(new Date());
      const allowed = rateSet?.kiwiSaver?.allowedEmployeeRates ?? [3, 3.5, 4, 6, 8, 10];
      const unchanged =
        existing != null && pct(Number(existing.kiwiSaverEmployeeRate)) === data.kiwiSaverEmployeeRate;
      const ok = allowed.some((a) => Number(a) === data.kiwiSaverEmployeeRate);
      if (!ok && !unchanged) {
        throw validationError(
          `KiwiSaver employee rate must be one of ${allowed.map((a) => `${a}%`).join(", ")} (3% remains legal only for pre-existing elections).`,
        );
      }
    }

    // ---- Compose the DB tax code (base + " SL" suffix) and derive the
    //      casual flag from the employment type. ----
    const taxCode = data.studentLoan ? `${data.taxCodeBase} SL` : data.taxCodeBase;
    const isCasual = data.employmentType === "CASUAL" || data.employmentType === "CASUAL_AGRICULTURAL";

    const payload = {
      irdNumber: irdDigits,
      taxCode,
      isCasual,
      // Phase 1A — the explicit declaration box + provenance + the
      // materialised auto-enrolment due date.
      studentLoan: data.studentLoan,
      taxCodeSource: existing?.taxCodeSource || "ADMIN",
      kiwiSaverStatus: data.kiwiSaverStatus,
      kiwiSaverEmployeeRate: data.kiwiSaverEmployeeRate == null ? null : dec(data.kiwiSaverEmployeeRate),
      kiwiSaverEmployerRate: data.kiwiSaverEmployerRate == null ? null : dec(data.kiwiSaverEmployerRate),
      taxCodeSpecialRate: data.stcCertificateRate == null ? null : dec(data.stcCertificateRate),
      stcAccTreatment: data.taxCodeBase === "STC" ? data.stcAccTreatment : "INC",
      stcStudentLoanRate: data.stcStudentLoanRate == null ? null : dec(data.stcStudentLoanRate),
      stcCertificateExpiry: data.stcCertificateExpiry ? utcMidnight(data.stcCertificateExpiry) : null,
      taxCodeEffectiveFrom: data.taxCodeEffectiveFrom ? utcMidnight(data.taxCodeEffectiveFrom) : null,
      esctRateOverride: data.esctRateOverride == null ? null : dec(data.esctRateOverride),
      employmentType: data.employmentType,
      casualHolidayPayInWages: data.casualHolidayPayInWages,
      employmentStartDate: data.employmentStartDate ? utcMidnight(data.employmentStartDate) : null,
      employmentEndDate: data.employmentEndDate ? utcMidnight(data.employmentEndDate) : null,
      autoEnrolExemption: "",
      autoEnrolDueDate: autoEnrolDueDate(
        data.employmentType,
        data.employmentStartDate ? utcMidnight(data.employmentStartDate) : null,
      ),
      notes: data.notes,
      createdById: existing?.createdById ?? auth.userId,
    };

    await db.employeeTaxProfile.upsert({
      where: { userId: user.id },
      update: payload,
      create: { userId: user.id, ...payload },
    });

    // ---- Warnings (saved, but surfaced). ----
    const warnings: string[] = [];
    if (data.employmentType === "CASUAL" && !data.casualHolidayPayInWages) {
      warnings.push(
        "Casual exemption requires holiday pay to be paid with wages. If holiday pay is paid on leave, consider TEMPORARY or PERMANENT.",
      );
    }
    if (
      data.taxCodeBase === "STC" &&
      data.stcCertificateExpiry &&
      utcMidnight(data.stcCertificateExpiry).getTime() < Date.now()
    ) {
      warnings.push(
        `The IR23 certificate expired on ${data.stcCertificateExpiry} — obtain a renewed certificate and update the rate.`,
      );
    }

    // ---- Guardrail 3: TEMPORARY → PERMANENT after 28 days requires an
    //      auto-enrolment audit entry. ----
    if (
      existing?.employmentType === "TEMPORARY" &&
      data.employmentType === "PERMANENT" &&
      (existing.employmentStartDate || data.employmentStartDate)
    ) {
      const start = existing.employmentStartDate ?? utcMidnight(data.employmentStartDate!);
      const now = new Date();
      const days = Math.round((now.getTime() - start.getTime()) / 86_400_000);
      if (days >= 28) {
        const due = autoEnrolDueDate("TEMPORARY", start);
        await logAudit({
          actor: auth,
          action: "tax.auto_enrolment_audited",
          entityType: "EMPLOYEE_TAX_PROFILE",
          entityId: user.id,
          entityLabel: user.name,
          detail: `${auth.name} converted ${user.name}'s employment from TEMPORARY (start ${start.toISOString().slice(0, 10)}) to PERMANENT after the 28-day rule (${days} days employed) — KiwiSaver auto-enrolment applies from day 29 (${due ? due.toISOString().slice(0, 10) : "—"}). Required audit entry recorded.`,
        });
      }
    }

    await logAudit({
      actor: auth,
      action: "tax.profile_updated",
      entityType: "EMPLOYEE_TAX_PROFILE",
      entityId: user.id,
      entityLabel: user.name,
      detail: `${auth.name} saved ${user.name}'s tax profile — code ${taxCode}${data.irdNumber ? `, IRD ${irdDigits.slice(0, 3)}-${irdDigits.slice(3, 6)}-${irdDigits.slice(6)}` : ""}, KiwiSaver ${data.kiwiSaverStatus}${data.kiwiSaverEmployeeRate != null ? ` @ ${data.kiwiSaverEmployeeRate}%` : ""}, employment ${data.employmentType}${warnings.length > 0 ? `. Warnings: ${warnings.join(" ")}` : ""}.`,
    });
    revalidatePath(`/employees/${user.id}/tax-profile`);
    revalidatePath("/employees");
    return { userId: user.id, warnings };
  });
}
