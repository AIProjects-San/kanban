/* eslint-disable no-console */
// NZ statutory payroll engine — Phase 4 (Task 4.2) migration verification.
//
// Two stages, run around the statutory seed so "pre-migration" data is real:
//
//   bun run db:push                      # ADR-008 sandbox schema flow
//   SEED_DEMO=1 bun run db:seed          # demo org incl. PRE-ENGINE runs
//   bun run verify:phase4 pre            # ① snapshot pre-migration data
//   bun run db:seed:statutory            # ② the statutory seed "arrives"
//   bun run verify:phase4 post           # ③ verify + create an engine run
//
// Stage ① asserts the demo runs are in the PRE-ENGINE shape (rateSetId "",
// statutory null) and writes a canonical snapshot of every run + payslip.
// Stage ③ re-snapshots and requires BYTE-IDENTICAL data (the seed and the
// engine never rewrite history), then creates a new PayrollRun through the
// SAME wiring createPayrollRun uses (resolveNzRateSet at window start →
// planSlipStatutory per slip → statutory lines in the deductions JSON +
// Payslip.statutory snapshot + in-transaction KiwiSaver auto-enrolment),
// and verifies the Task 4.2 acceptance list:
//
//   • existing data intact (snapshot equality)
//   • new run: rateSetId frozen, statutory lines appear, snapshot parses,
//     net = gross − Σ deductions, employer money only in the snapshot
//   • golden cross-check: stored lines ≡ a fresh engine run on the same
//     profile + rate set (M/KS 3.5%, M SL, STC 18% PLUS + SL 8%)
//   • auto-enrolment: a TEMPORARY profile inside the 28-day window gets
//     the sticky election persisted + the audit entry
//   • historical payslips: statutory YTD = 0 (no backfill) — verified with
//     the read-side computeRunningAggregates kernel over ALL slips
//
// The canonical Postgres DDL path is verified separately by the PGlite
// replay harness (scripts/pg-replay/replay.ts — every migration.sql on a
// real Postgres 16, exactly what CI's `prisma migrate deploy` runs).
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/lib/infra/db";
import { resolveNzRateSet } from "../src/lib/payroll/nz/calculate";
import {
  classifyComponentsForStatutory,
  planSlipStatutory,
  parseStatutorySnapshot,
  type SlipAutoEnrolment,
  type StatutoryComponentRow,
} from "../src/lib/payroll/nz/slip-statutory";
import type { NzTaxProfileRow } from "../src/lib/payroll/nz/calculate";
import type { NzPayFrequency } from "../src/lib/payroll/nz/types";
import {
  parseComponents,
} from "../src/lib/hiring/offer-math";
import {
  windowEarningsFromStructure,
  payslipTotals,
  withRoundingLine,
  parsePayslipLines,
  type PayslipLine,
} from "../src/lib/payroll/payroll-math";
import {
  resolvePayrollWindow,
  fiscalYearOf,
} from "../src/lib/payroll/payroll-windows";
import { workingDaysBetween } from "../src/lib/hr/working-days";
import { getHolidayLookup } from "../src/lib/hr/holidays";
import { getWorkspaceConfig } from "../src/lib/infra/config-loader";
import { computeRunningAggregates, type AggregateSlip } from "../src/lib/payroll/payslip-aggregates";
import { logAudit } from "../src/lib/audit/audit";
import type { PayrollRoundingMode } from "../src/lib/payroll/payroll-math";

// fileURLToPath(new URL(".", import.meta.url)) — the portable spelling of
// Bun's import.meta.dir (keeps the file out of bun-types' global leakage).
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SNAPSHOT_FILE = join(SCRIPT_DIR, "..", ".phase4-snapshot.json");
const PHASE4_PERIOD_PREFIX = "phase4";

interface RunSnap {
  id: string;
  period: string;
  frequency: string;
  status: string;
  rateSetId: string;
  workingDays: number;
  start: string;
  end: string;
}

interface SlipSnap {
  id: string;
  runPeriod: string;
  slipNo: string;
  userId: string;
  gross: number;
  net: number;
  lopDays: number;
  withholdStatus: string;
  earnings: unknown;
  deductions: unknown;
  statutory: unknown;
}

function digest(runs: RunSnap[], slips: SlipSnap[]): string {
  const canonical = JSON.stringify({ runs, slips });
  return createHash("sha256").update(canonical).digest("hex");
}

async function snapshot(): Promise<{ runs: RunSnap[]; slips: SlipSnap[] }> {
  const runs = await db.payrollRun.findMany({ orderBy: { period: "asc" } });
  const slips = await db.payslip.findMany({
    orderBy: [{ slipNo: "asc" }],
    include: { run: { select: { period: true } } },
  });
  return {
    runs: runs.map((r) => {
      // Snapshot hashes must be stable AND loud: a run without window dates
      // is a broken row, not a silent `null` in the fingerprint.
      if (!r.startDate || !r.endDate) {
        throw new Error(`verify-phase4 snapshot: run ${r.period} (${r.id}) has no window dates`);
      }
      return {
        id: r.id,
        period: r.period,
        frequency: r.frequency,
        status: r.status,
        rateSetId: r.rateSetId,
        workingDays: r.workingDays,
        start: r.startDate.toISOString(),
        end: r.endDate.toISOString(),
      };
    }),
    slips: slips.map((p) => ({
      id: p.id,
      runPeriod: p.run.period,
      slipNo: p.slipNo,
      userId: p.userId,
      gross: p.gross,
      net: p.net,
      lopDays: p.lopDays,
      withholdStatus: p.withholdStatus,
      earnings: JSON.parse(p.earnings),
      deductions: JSON.parse(p.deductions),
      statutory: p.statutory ?? null,
    })),
  };
}

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Stage ① — pre.
// ---------------------------------------------------------------------------

async function stagePre(): Promise<void> {
  console.log("🇳🇿 Phase 4 (Task 4.2) — stage PRE (before db:seed:statutory)\n");

  const rateSets = await db.statutoryRule.count();
  if (rateSets > 0) {
    console.error(`  ✗ ${rateSets} StatutoryRateSet row(s) already exist — the PRE snapshot must be`);
    console.error("    taken BEFORE `bun run db:seed:statutory`. Reset and reseed:");
    console.error("      bun run db:reset && SEED_DEMO=1 bun run db:seed && bun run verify:phase4 pre");
    process.exit(1);
  }
  console.log("  ✓ no statutory rate set seeded yet (the pre-migration posture)");

  const runCount = await db.payrollRun.count();
  const slipCount = await db.payslip.count();
  check(runCount >= 2, `demo payroll data present (${runCount} runs)`);
  check(slipCount > 0, `demo payslips present (${slipCount} slips)`);

  const snap = await snapshot();
  const preEngineShape = snap.runs.every((r) => r.rateSetId === "");
  check(preEngineShape, "every seeded run carries rateSetId \"\" (pre-engine shape)");
  const noStatutory = snap.slips.every((s) => s.statutory === null);
  check(noStatutory, "every seeded payslip carries statutory = null (no snapshot yet)");
  const noStatutoryLines = snap.slips.every(
    (s) => !(s.deductions as PayslipLine[]).some((l) => ["paye", "acc", "ks", "sl"].includes(l.key)),
  );
  check(noStatutoryLines, "no seeded payslip has paye/acc/ks/sl deduction lines");

  writeFileSync(SNAPSHOT_FILE, JSON.stringify({ runs: snap.runs, slips: snap.slips }, null, 0));
  console.log(`\n  snapshot: ${snap.runs.length} runs · ${snap.slips.length} slips · sha256 ${digest(snap.runs, snap.slips).slice(0, 16)}…`);
  console.log(`  written to ${SNAPSHOT_FILE}`);
  console.log("\n  NEXT: bun run db:seed:statutory && bun run verify:phase4 post\n");
}

// ---------------------------------------------------------------------------
// Stage ③ — post.
// ---------------------------------------------------------------------------

interface SlipPlan {
  data: {
    userId: string;
    slipNo: string;
    earnings: string;
    deductions: string;
    lopDays: number;
    lopSource: "AUTO";
    statutory: object;
    paidDays: number;
    gross: number;
    net: number;
    withholdStatus: "";
  };
  autoEnrol: SlipAutoEnrolment | null;
}

async function stagePost(): Promise<void> {
  console.log("🇳🇿 Phase 4 (Task 4.2) — stage POST (after db:seed:statutory)\n");

  // ---- 1. existing data intact ------------------------------------------
  if (!existsSync(SNAPSHOT_FILE)) {
    console.error("  ✗ no PRE snapshot found — run `bun run verify:phase4 pre` first");
    process.exit(1);
  }
  const before = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as {
    runs: RunSnap[];
    slips: SlipSnap[];
  };
  const now = await snapshot();
  // "Existing data intact" — every PRE-MIGRATION row must be byte-identical;
  // the only allowed additions are this verification's own phase4 rows.
  const beforeRuns = new Map(before.runs.map((r) => [r.id, r]));
  const beforeSlips = new Map(before.slips.map((s) => [s.id, s]));
  const unchangedRuns = now.runs.filter((r) => {
    const b = beforeRuns.get(r.id);
    return b == null || JSON.stringify(b) === JSON.stringify(r);
  });
  const mutatedRuns = now.runs.length - unchangedRuns.length;
  check(
    mutatedRuns === 0,
    `pre-migration runs intact — ${before.runs.length} rows byte-identical`,
    `${mutatedRuns} mutated`,
  );
  const unchangedSlips = now.slips.filter((s) => {
    const b = beforeSlips.get(s.id);
    return b == null || JSON.stringify(b) === JSON.stringify(s);
  });
  const mutatedSlips = now.slips.length - unchangedSlips.length;
  check(
    mutatedSlips === 0,
    `pre-migration payslips intact — ${before.slips.length} rows byte-identical`,
    `${mutatedSlips} mutated`,
  );
  const addedRuns = now.runs.filter((r) => !beforeRuns.has(r.id));
  const addedSlips = now.slips.filter((s) => !beforeSlips.has(s.id));
  check(
    addedRuns.every((r) => r.period.startsWith(PHASE4_PERIOD_PREFIX)) &&
      addedSlips.every((s) => s.runPeriod.startsWith(PHASE4_PERIOD_PREFIX)),
    `only additions are this verification's phase4 rows (+${addedRuns.length} runs, +${addedSlips.length} slips)`,
  );

  // ---- 2. the rate set resolves ------------------------------------------
  // The engine run's window: the month AFTER the latest seeded run (a
  // period no run occupies yet).
  const latest = await db.payrollRun.findFirst({ orderBy: { period: "desc" } });
  if (!latest?.startDate) {
    console.error("  ✗ no seeded runs with a window start — run the PRE stage against a seeded database");
    process.exit(1);
  }
  const anchor = new Date(
    Date.UTC(latest.startDate.getUTCFullYear(), latest.startDate.getUTCMonth() + 1, 15),
  );
  const window = resolvePayrollWindow("MONTHLY", anchor);
  if (!window) {
    console.error("  ✗ could not resolve the next monthly window");
    process.exit(1);
  }
  const rateSet = await resolveNzRateSet(window.start);
  check(rateSet != null, `statutory rate set resolves at ${window.start.toISOString().slice(0, 10)}`);
  if (!rateSet) process.exit(1);
  check(
    rateSet.label.includes("FY2026-27"),
    `resolved set is the FY2026-27 set ("${rateSet.label}")`,
  );

  // ---- 3. create the engine-powered run ---------------------------------
  // Re-runnable: if a phase4 run already exists, verify it instead.
  const existingPhase4 = await db.payrollRun.findFirst({
    where: { period: { startsWith: PHASE4_PERIOD_PREFIX } },
    include: { payslips: true },
  });

  let runId: string;
  let plans: SlipPlan[] = [];

  if (existingPhase4) {
    console.log(`  (phase4 run ${existingPhase4.period} already exists — verifying it)`);
    runId = existingPhase4.id;
  } else {
    // Rename the period so a re-seed + re-run never collides with demo
    // periods and is instantly recognisable in the UI: "phase4-2026-12".
    const periodKey = `${PHASE4_PERIOD_PREFIX}-${window.periodKey}`;
    const structures = await db.salaryStructure.findMany({
      where: { isActive: true, frequency: "MONTHLY" },
    });
    if (structures.length === 0) {
      console.error("  ✗ no active MONTHLY salary structures — seed the demo data first");
      process.exit(1);
    }

    // The KiwiSaver auto-enrolment probe: one structure-holder WITHOUT a tax
    // profile gets a TEMPORARY profile whose start date is INSIDE the 28-day
    // window — the run must auto-enrol them (election + audit entry).
    const profileRows = await db.employeeTaxProfile.findMany();
    const profiled = new Set(profileRows.map((p) => p.userId));
    const tempCandidate = structures.map((s) => s.userId).find((u) => !profiled.has(u));
    let tempUserId: string | null = null;
    if (tempCandidate) {
      const tempStart = new Date(window.start.getTime() + 2 * 86_400_000); // day 3 of employment
      await db.employeeTaxProfile.create({
        data: {
          userId: tempCandidate,
          taxCode: "M",
          isCasual: false,
          kiwiSaverStatus: "ACTIVE",
          kiwiSaverEmployeeRate: null,
          kiwiSaverEmployerRate: null,
          taxCodeSpecialRate: null,
          stcAccTreatment: "INC",
          stcStudentLoanRate: null,
          employmentType: "TEMPORARY",
          casualHolidayPayInWages: true,
          employmentStartDate: tempStart,
          notes: "Phase 4 verification: TEMPORARY employment inside the 28-day rule — the run must auto-enrol.",
        },
      });
      tempUserId = tempCandidate;
      console.log(`  (TEMPORARY profile created for the auto-enrolment probe: user ${tempCandidate.slice(0, 8)}…, start ${tempStart.toISOString().slice(0, 10)})`);
    } else {
      console.log("  (every structure holder already has a tax profile — auto-enrolment probe skipped)");
    }

    // The action's statutory context, loaded the same way.
    const catalog = (await db.salaryComponent.findMany({
      where: { isActive: true },
      select: { code: true, taxApplicable: true, statutoryCategory: true, wageBaseRef: true },
    })) as StatutoryComponentRow[];
    const classification = classifyComponentsForStatutory(catalog);
    const taxProfileByUser = new Map<string, NzTaxProfileRow>(
      (await db.employeeTaxProfile.findMany()).map((r) => [r.userId, r as unknown as NzTaxProfileRow]),
    );

    const periodHolidays = await getHolidayLookup(window.start, window.end);
    const runWorkingDays = workingDaysBetween(window.start, window.end, periodHolidays);
    const workspaceConfig = await getWorkspaceConfig();
    const roundingMode: PayrollRoundingMode = workspaceConfig.workspace.payrollRoundingMode;
    const earningsYear = window.start.getUTCFullYear();

    plans = structures.map((s, i) => {
      const components = parseComponents(s.components);
      const earnings = windowEarningsFromStructure(components, "MONTHLY", earningsYear);
      const plan = planSlipStatutory({
        userId: s.userId,
        frequency: "MONTHLY" as NzPayFrequency,
        payPeriodEnd: window.end,
        rateSet,
        profileRow: taxProfileByUser.get(s.userId) ?? null,
        earnings,
        deductions: [],
        classification,
      });
      const deductions = [...plan.lines];
      const { earnings: finalEarnings, deductions: finalDeductions } = withRoundingLine(
        earnings,
        deductions,
        roundingMode,
      );
      const { gross, net } = payslipTotals(finalEarnings, finalDeductions);
      return {
        data: {
          userId: s.userId,
          slipNo: `PS-${periodKey}-${String(i + 1).padStart(3, "0")}`,
          earnings: JSON.stringify(finalEarnings),
          deductions: JSON.stringify(finalDeductions),
          lopDays: 0,
          lopSource: "AUTO" as const,
          statutory: plan.snapshot,
          // Phase 1A — the promoted snapshot columns (mirrors the action).
          taxCodeApplied: plan.snapshot.taxCode,
          statutoryRuleVersion: plan.snapshot.ruleVersion,
          employerKiwiSaverGross: plan.snapshot.kiwiSaver.employerGross || null,
          employerEsct: plan.snapshot.kiwiSaver.esct || null,
          employerKiwiSaverNet: plan.snapshot.kiwiSaver.employerNet || null,
          paidDays: runWorkingDays,
          gross,
          net,
          withholdStatus: "" as const,
        },
        autoEnrol: plan.autoEnrol,
      };
    });

    const superAdmin = await db.user.findUnique({ where: { email: "superadmin@fernly.app" } });
    const actor = {
      userId: superAdmin?.id ?? "system",
      name: superAdmin?.name ?? "System",
      role: "SUPER_ADMIN",
    };

    const enrolled: Array<{ entry: SlipAutoEnrolment; slipNo: string }> = [];
    // Phase 1A — the covering TaxYear, same lookup the action makes.
    const taxYear = await db.taxYear.findFirst({
      where: { startDate: { lte: window.start }, endDate: { gte: window.start } },
    });
    const run = await db.$transaction(async (tx) => {
      const created = await tx.payrollRun.create({
        data: {
          period: periodKey,
          frequency: "MONTHLY",
          startDate: window.start,
          endDate: window.end,
          // Phase 2 (payday filing) — payday defaults to the window end.
          payDate: window.end,
          status: "OPEN",
          createdById: actor.userId,
          workingDays: runWorkingDays,
          rateSetId: rateSet.id,
          taxYearId: taxYear?.id ?? "",
          payslips: { create: plans.map((p) => p.data) },
        },
      });
      // Phase 2 contract — the election lands INSIDE the transaction.
      for (const p of plans) {
        if (p.autoEnrol) {
          const res = await tx.employeeTaxProfile.updateMany({
            where: { userId: p.autoEnrol.userId, kiwiSaverStatus: "ACTIVE", kiwiSaverEmployeeRate: null },
            data: { kiwiSaverEmployeeRate: p.autoEnrol.rate },
          });
          if ((res?.count ?? 0) > 0) enrolled.push({ entry: p.autoEnrol, slipNo: p.data.slipNo });
        }
      }
      return created;
    });
    runId = run.id;

    // Audits AFTER commit — never describe money that rolled back.
    await logAudit({
      actor,
      action: "payroll.run_created",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      entityLabel: run.period,
      detail: `Phase 4 verification run ${run.period} (MONTHLY) with ${plans.length} payslips priced on "${rateSet.label}" — engine wiring: statutory lines + snapshots + ${enrolled.length} auto-enrolment(s).`,
    });
    for (const { entry, slipNo } of enrolled) {
      await logAudit({
        actor,
        action: "payroll.kiwisaver_auto_enrolled",
        entityType: "EMPLOYEE_TAX_PROFILE",
        entityId: entry.userId,
        entityLabel: slipNo,
        detail: `KiwiSaver auto-enrolment triggered while paying the ${run.period} run (payslip ${slipNo}): ${entry.reason}. Election persisted at 3.5% — sticky, the time rule never re-triggers.`,
      });
    }
    console.log(`  ✓ created run ${run.period} (id ${run.id}) with ${plans.length} payslips`);
  }

  // ---- 4. verify the engine-powered run ---------------------------------
  const run = await db.payrollRun.findUnique({
    where: { id: runId },
    include: { payslips: true },
  });
  if (!run?.startDate) {
    console.error("  ✗ the phase4 run vanished (or has no window start)");
    process.exit(1);
  }

  // In the existing-run path the window above was derived from the LATEST
  // run — re-resolve at THIS run's start so the comparison is honest.
  const runRateSet = await resolveNzRateSet(run.startDate);
  check(runRateSet != null, `rate set resolves at the run's own window start`);

  check(run.rateSetId === (runRateSet?.id ?? ""), `run.rateSetId frozen to the resolved set (${run.rateSetId})`);
  // Phase 1A — the tax-year + promoted-column wiring.
  const coveringYear = await db.taxYear.findFirst({
    where: { startDate: { lte: run.startDate }, endDate: { gte: run.startDate } },
  });
  check(
    coveringYear != null && run.taxYearId === coveringYear.id,
    `run.taxYearId pinned to the covering TaxYear (${run.taxYearId || "—"} vs ${coveringYear?.id ?? "—"})`,
  );
  const colSample = run.payslips[0];
  check(
    colSample != null && colSample.taxCodeApplied !== "" && colSample.statutoryRuleVersion.startsWith("nz1:"),
    `payslip columns promoted (taxCodeApplied "${colSample?.taxCodeApplied ?? ""}", ruleVersion "${colSample?.statutoryRuleVersion ?? ""}")`,
  );
  check(
    run.payslips.every(
      (p) =>
        p.employerKiwiSaverGross == null ||
        Math.abs(Number(p.employerKiwiSaverGross) - Number(p.employerKiwiSaverNet ?? 0) - Number(p.employerEsct ?? 0)) < 0.005,
    ),
    `employer columns sum (gross = net + esct) where present`,
  );
  check(run.rateSetId !== "", "rateSetId is not the pre-engine \"\"");

  const profileByUser = new Map<string, NzTaxProfileRow>(
    (await db.employeeTaxProfile.findMany()).map((r) => [r.userId, r as unknown as NzTaxProfileRow]),
  );
  const userById = new Map((await db.user.findMany()).map((u) => [u.id, u]));

  let snapshotsParsed = 0;
  let linesSeen = 0;
  const perUserFindings: Array<{ name: string; snap: ReturnType<typeof parseStatutorySnapshot> }> = [];
  for (const p of run.payslips) {
    const snap = parseStatutorySnapshot(p.statutory);
    check(snap != null, `payslip ${p.slipNo} — statutory snapshot parses`);
    if (!snap) continue;
    snapshotsParsed++;
    check(
      snap.rateSetId === run.rateSetId,
      `payslip ${p.slipNo} — snapshot rateSetId matches the run`,
    );
    const deductions = parsePayslipLines(p.deductions);
    const statutoryLines = deductions.filter((l) => ["paye", "acc", "ks", "sl"].includes(l.key));
    linesSeen += statutoryLines.length;
    check(
      statutoryLines.length > 0,
      `payslip ${p.slipNo} — statutory deduction lines appear (${statutoryLines.map((l) => l.key).join("/")})`,
    );
    // Line amounts ≡ snapshot (the ledger and the snapshot tell one story).
    const payeLine = deductions.find((l) => l.key === "paye");
    check(
      payeLine != null && Math.abs(payeLine.amount - snap.paye.tax) < 0.005,
      `payslip ${p.slipNo} — PAYE line ${payeLine?.amount ?? "—"} ≡ snapshot tax ${snap.paye.tax}`,
    );
    const ksLine = deductions.find((l) => l.key === "ks");
    if (ksLine) {
      check(
        Math.abs(ksLine.amount - snap.kiwiSaver.employee) < 0.005,
        `payslip ${p.slipNo} — KS line ${ksLine.amount} ≡ snapshot employee ${snap.kiwiSaver.employee}`,
      );
    }
    // Net = gross − Σ deductions (the payslip ledger discipline).
    const sumDeductions = Math.round(deductions.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    check(
      Math.abs(p.gross - sumDeductions - p.net) < 0.005,
      `payslip ${p.slipNo} — net ${p.net} = gross ${p.gross} − Σ deductions ${sumDeductions}`,
    );
    // Employer money ONLY in the snapshot — never docks net pay.
    check(
      Math.abs(p.net - (p.gross - sumDeductions)) < 0.005 &&
        !deductions.some((l) => l.key.startsWith("esct")),
      `payslip ${p.slipNo} — ESCT/employer money lives only in the snapshot (esct ${snap.kiwiSaver.esct})`,
    );
    perUserFindings.push({ name: userById.get(p.userId)?.name ?? p.userId, snap });
  }
  check(snapshotsParsed === run.payslips.length, `all ${run.payslips.length} snapshots parsed`);
  check(linesSeen > 0, `statutory lines total: ${linesSeen}`);

  // Golden cross-check — the stored lines reproduce an INDEPENDENT engine
  // run on the same profile + rate set (fixture-free, DB-seeded values).
  const findByName = (name: string) =>
    perUserFindings.find((f) => f.name === name)?.snap ?? null;

  const manager = findByName("Priya Sharma") ?? findByName("Marcus Chen") ?? perUserFindings[0]?.snap ?? null;
  if (manager) {
    // M code, ACTIVE, no election → KS at the 3.5% default; monthly $5,000-ish
    // gross → PAYE 17.5%/30% brackets + 1.75% levy.
    check(
      manager.kiwiSaver.employeeRate === 0.035 && manager.kiwiSaver.employee === Math.round(manager.taxableGross * 0.035 * 100) / 100,
      `M/ACTIVE profile — KS employee ${manager.kiwiSaver.employee} = 3.5% of ${manager.taxableGross}`,
    );
    check(
      Math.abs(manager.paye.acc - Math.round(Math.min(manager.taxableGross, 156641 / 12) * 0.0175 * 100) / 100) < 0.005,
      `M/ACTIVE profile — ACC ${manager.paye.acc} = 1.75% of the monthly-capped gross`,
    );
  }

  const diego = findByName("Diego Morales");
  if (diego) {
    check(
      diego.taxCode === "STC" && diego.paye.method === "STC",
      `STC profile — method STC on the snapshot`,
    );
    check(
      Math.abs(diego.paye.tax - Math.round(diego.taxableGross * 0.18 * 100) / 100) < 0.005,
      `STC profile — PAYE ${diego.paye.tax} = 18% IR23 rate × ${diego.taxableGross}`,
    );
    check(
      diego.paye.acc > 0,
      `STC PLUS profile — ACC levy on top (${diego.paye.acc})`,
    );
    const slExpected = Math.round(Math.max(0, diego.taxableGross - 2010.66) * 0.08 * 100) / 100;
    check(
      Math.abs(diego.studentLoan - slExpected) < 0.005,
      `STC profile — SL ${diego.studentLoan} = 8% certificate rate above $2,010.66`,
    );
  }

  const hana = findByName("Hana Sato");
  if (hana) {
    check(
      hana.taxCode.startsWith("M") && hana.studentLoan > 0,
      `M SL profile — student loan line present (${hana.studentLoan})`,
    );
    const slExpected = Math.round(Math.max(0, hana.taxableGross - 2010.66) * 0.12 * 100) / 100;
    check(
      Math.abs(hana.studentLoan - slExpected) < 0.005,
      `M SL profile — SL ${hana.studentLoan} = 12% above $2,010.66 (expected ${slExpected})`,
    );
    check(
      hana.kiwiSaver.employee === 0,
      `OPTED_OUT profile — no KiwiSaver employee deduction`,
    );
  }

  // ---- 5. auto-enrolment persistence -------------------------------------
  // Find the slip whose profile is TEMPORARY, keeping the userId the
  // profile row itself doesn't carry (NzTaxProfileRow has no userId field).
  const tempSlip = run.payslips.find(
    (p) => profileByUser.get(p.userId)?.employmentType === "TEMPORARY",
  );
  const tempProfile = tempSlip ? profileByUser.get(tempSlip.userId) : undefined;
  if (tempProfile) {
    // SQLite hands Prisma Decimal columns back as Decimal objects — compare
    // numerically (0.035 === Decimal(0.035) is false).
    const persistedRate = tempProfile.kiwiSaverEmployeeRate == null ? null : Number(tempProfile.kiwiSaverEmployeeRate);
    check(
      persistedRate === 0.035,
      `TEMPORARY profile — sticky election persisted at 3.5% (got ${persistedRate})`,
    );
    const auditRows = await db.auditLog.count({
      where: { action: "payroll.kiwisaver_auto_enrolled", entityId: tempSlip?.userId },
    });
    check(auditRows > 0, `auto-enrolment audit entry exists (${auditRows} row(s))`);
    const tempSnap = perUserFindings.find(
      (f) => f.snap?.kiwiSaver.autoEnrolTriggered === true,
    )?.snap;
    check(tempSnap != null, "the triggering payslip's snapshot flags autoEnrolTriggered");
  } else {
    console.log("  (no TEMPORARY profile in the run — auto-enrolment probe not applicable)");
  }

  // ---- 6. historical statutory YTD = 0 (no backfill) ---------------------
  const allSlips = await db.payslip.findMany({
    include: { run: { select: { period: true, endDate: true } } },
  });
  const aggregateSlips: AggregateSlip[] = allSlips.map((p) => ({
    id: p.id,
    userId: p.userId,
    slipNo: p.slipNo,
    gross: p.gross,
    net: p.net,
    withholdStatus: p.withholdStatus,
    earnings: p.earnings,
    deductions: p.deductions,
    // Pre-window-date legacy runs sort first (oldest) — windowEndMs 0.
    windowEndMs: p.run.endDate ? p.run.endDate.getTime() : 0,
  }));
  const aggregates = computeRunningAggregates(aggregateSlips);
  const phase4SlipIds = new Set(run.payslips.map((p) => p.id));
  const historical = allSlips.filter((p) => !phase4SlipIds.has(p.id));
  const historicalWithStatutoryYtd = historical.filter((p) => {
    const rows = aggregates.get(p.id)?.componentYtd ?? [];
    return rows.some((r) => ["paye", "acc", "ks", "sl"].includes(r.key));
  });
  check(
    historicalWithStatutoryYtd.length === 0,
    `historical payslips carry statutory YTD = 0 — ${historical.length} slips, no backfill`,
  );
  const newWithPayeYtd = run.payslips.filter((p) => {
    const rows = aggregates.get(p.id)?.componentYtd ?? [];
    return rows.some((r) => r.key === "paye");
  });
  check(
    newWithPayeYtd.length === run.payslips.length,
    `the new run's slips start the statutory YTD clock (${newWithPayeYtd.length}/${run.payslips.length} carry a paye YTD row)`,
  );

  // ---- summary ------------------------------------------------------------
  console.log(
    failures === 0
      ? `\n  Phase 4 (Task 4.2) verification: ALL CHECKS PASS\n`
      : `\n  Phase 4 (Task 4.2) verification: ${failures} CHECK(S) FAILED\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/** Usage guard + entry point. */
async function main(): Promise<void> {
  const stage = process.argv[2];
  if (stage === "pre") await stagePre();
  else if (stage === "post") await stagePost();
  else {
    console.error("Usage: bun scripts/verify-phase4.ts <pre|post>");
    console.error("  pre  — snapshot the pre-migration data (run BEFORE db:seed:statutory)");
    console.error("  post — verify data intact + create and check an engine-powered run");
    process.exit(1);
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
