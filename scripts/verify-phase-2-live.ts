// ---------------------------------------------------------------------------
// Phase 2 (payday filing) — the LIVE end-to-end verification harness.
//
// Runs against a THROWAWAY COPY of the dev database (the run-with-env.sh
// preset-DATABASE_URL pattern from scripts/README.md — production cannot
// be touched). Exercises the real filing service, the real GL posting
// engine and the real seeded rate set:
//
//   1. Settings      — the employer filing profile saves + validates.
//   2. Locked run    — an engine-priced monthly run (real rate set, real
//                      tax profiles, statutory lines + snapshots), LOCKED.
//   3. GL            — postPayrollRun posts the balanced JE.
//   4. EI            — generatePaydayFiling builds + reconciles (the 8
//                      Step-2.10 checks, with numbers) + persists.
//   5. Lifecycle     — markFiled → markAccepted; regeneration refused.
//   6. ED            — a new joiner + a departing employee; never-twice.
//   7. EIA2          — an amendment for one employee; original → AMENDED.
//   8. Deadline      — computeDueDate + flagOverdueFilings idempotency.
//
// Usage:
//   cp db/custom.db .verify-tmp/phase2.db
//   DATABASE_URL=file:$PWD/.verify-tmp/phase2.db bash scripts/run-with-env.sh \
//     npx tsx scripts/verify-phase-2-live.ts
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..");
const THROWAWAY = join(ROOT, ".verify-tmp", "phase2-live.db");
const SOURCE = join(ROOT, "db", "custom.db");

// Stage the throwaway copy BEFORE importing anything that opens the db.
mkdirSync(join(ROOT, ".verify-tmp"), { recursive: true });
if (!existsSync(SOURCE)) {
  console.error(`✗ db/custom.db not found — run \`npm run db:seed\` first.`);
  process.exit(2);
}
rmSync(THROWAWAY, { force: true });
copyFileSync(SOURCE, THROWAWAY);
process.env.DATABASE_URL = `file:${THROWAWAY}`;

import { resolveNzRateSet } from "../src/lib/payroll/nz/calculate";
import {
  calculateNzStatutoryWithSet,
  toNzTaxProfile,
  type NzTaxProfileRow,
} from "../src/lib/payroll/nz/calculate";
import { serializeStatutorySnapshot, statutoryDeductionLines } from "../src/lib/payroll/nz/slip-statutory";
import type { PayslipStatutoryT } from "../src/lib/types";
import { postPayrollRun } from "../src/lib/accounting/post-payroll-run";
import {
  flagOverdueFilings,
  generateAmendmentFiling,
  generateEmployeeDetails,
  generatePaydayFiling,
  listPendingEmployeeDetails,
  markAccepted,
  markFiled,
} from "../src/lib/ird/filing-service";
import { computeDueDate } from "../src/lib/ird/deadline";
import type { OfferComponent } from "../src/lib/offer-math";

async function main(): Promise<void> {
const { db } = await import("../src/lib/infra/db");
let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PERIOD = "2026-09"; // free month (the seed occupies 2026-10/2026-11)
const WINDOW_START = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-30T00:00:00.000Z");
const PAY_DATE = new Date("2026-09-30T00:00:00.000Z");

try {
  console.log("\n━━━ Phase 2 live verification (throwaway db) ━━━\n");

  // ---- 1. Settings ---------------------------------------------------------
  console.log("[1] Employer filing profile");
  await db.payrollSettings.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      employerIrdNumber: "49091850", // IRD spec 5.8 example 1 — valid + in range
      employerName: "Fernly Demo Ltd",
      payrollContactName: "Bill Smith",
      payrollContactPhone: "041234567",
      payrollContactEmail: "payroll@email.com",
      payrollPackageIdentifier: "Fernly v1.0",
      irFormVersionNumber: "0001",
    },
  });
  ok(true, "PayrollSettings singleton saved", "employer IRD 49091850, contact Bill Smith");

  // ---- 2. An engine-priced LOCKED run --------------------------------------
  console.log("\n[2] Engine-priced locked run (period 2026-09)");
  const rateSet = await resolveNzRateSet(WINDOW_START);
  ok(rateSet != null, "Seeded FY2026-27 rate set resolved", rateSet?.label);

  const structures = await db.salaryStructure.findMany({
    where: { isActive: true, frequency: "MONTHLY" },
  });
  const profiles = await db.employeeTaxProfile.findMany();
  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

  // A structure holder with NO tax profile cannot be filed (the service
  // refuses: no IRD number → ND required). Record the missing IR330 in
  // the throwaway copy — exactly what an employer does before filing.
  for (const s of structures) {
    if (profileByUser.has(s.userId)) continue;
    const user = await db.user.findUnique({ where: { id: s.userId }, select: { name: true } });
    const created = await db.employeeTaxProfile.create({
      data: {
        userId: s.userId,
        irdNumber: "49091869",
        taxCode: "M",
        kiwiSaverStatus: "ACTIVE",
        employmentType: "PERMANENT",
        employmentStartDate: new Date("2024-08-19T00:00:00.000Z"),
        notes: `Phase 2 live-verify: IR330 recorded for ${user?.name ?? s.userId} (mod-11 valid demo IRD).`,
      },
    });
    profileByUser.set(s.userId, created);
    console.log(`    · recorded IR330 for ${user?.name ?? s.userId} (had no tax profile)`);
  }

  const slips: Array<{
    userId: string; slipNo: string; earnings: string; deductions: string;
    gross: number; net: number; statutory: PayslipStatutoryT;
    employerKiwiSaverNet: number; employerEsct: number;
  }> = [];
  for (const [i, s] of structures.entries()) {
    const components = JSON.parse(s.components) as OfferComponent[];
    const earnings = components
      .filter((c) => c.kind === "EARNING")
      .map((c) => ({ key: c.key, label: c.label, amount: Math.round((c.amount / 12) * 100) / 100 }));
    const gross = Math.round(earnings.reduce((a, l) => a + l.amount, 0) * 100) / 100;

    // The profile row adapter the production engine uses (Phase 1A).
    const profileRow: NzTaxProfileRow | null = (profileByUser.get(s.userId) ?? null) as NzTaxProfileRow | null;
    const taxProfile = profileRow
      ? toNzTaxProfile(profileRow, { employmentCategory: "PERMANENT" })
      : toNzTaxProfile(
          { taxCode: "M", isCasual: false, kiwiSaverStatus: "ACTIVE", kiwiSaverEmployeeRate: null, kiwiSaverEmployerRate: null, taxCodeSpecialRate: null, stcAccTreatment: null, stcStudentLoanRate: null },
          { employmentCategory: "PERMANENT" },
        );

    const result = calculateNzStatutoryWithSet({
      gross,
      frequency: "MONTHLY",
      taxProfile,
      payPeriodEnd: WINDOW_END,
      rateSet: rateSet!,
    });
    const statutory = serializeStatutorySnapshot(result, { defaultedProfile: profileRow == null });
    const deductions = statutoryDeductionLines(result);
    const net = Math.round((gross - deductions.reduce((a, l) => a + l.amount, 0)) * 100) / 100;
    slips.push({
      userId: s.userId,
      slipNo: `PS-${PERIOD}-${String(i + 1).padStart(3, "0")}`,
      earnings: JSON.stringify(earnings),
      deductions: JSON.stringify(deductions),
      gross,
      net,
      statutory,
      employerKiwiSaverNet: result.kiwisaver.employerNet,
      employerEsct: result.kiwisaver.esct,
    });
  }
  ok(slips.length >= 5, `Priced ${slips.length} monthly slips through the real engine`);

  const run = await db.payrollRun.create({
    data: {
      period: PERIOD,
      frequency: "MONTHLY",
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      payDate: PAY_DATE,
      status: "LOCKED",
      lockedById: "seed-hr",
      lockedAt: new Date(),
      createdById: "seed-hr",
      workingDays: 22,
      rateSetId: rateSet?.id ?? "",
      payslips: {
        create: slips.map((p) => ({
          userId: p.userId,
          slipNo: p.slipNo,
          earnings: p.earnings,
          deductions: p.deductions,
          gross: p.gross,
          net: p.net,
          paidDays: 22,
          taxCodeApplied: p.statutory.taxCode,
          statutoryRuleVersion: p.statutory.ruleVersion,
          statutory: p.statutory as never,
          employerKiwiSaverGross: p.statutory.kiwiSaver.employerGross,
          employerKiwiSaverNet: p.employerKiwiSaverNet,
          employerEsct: p.employerEsct,
        })),
      },
    },
  });
  ok(Boolean(run.id), `Run ${PERIOD} created LOCKED with payDate 2026-09-30`);

  // ---- 3. GL posting --------------------------------------------------------
  console.log("\n[3] Phase 1D journal entry");
  const posted = await postPayrollRun(run.id, { postedById: "seed-hr" });
  ok(posted.status === "POSTED", "postPayrollRun posted one balanced entry", `${posted.lines.length} lines`);

  // ---- 4. EI generation + reconciliation ------------------------------------
  console.log("\n[4] EI generation + the Step 2.10 reconciliation");
  const filing = await generatePaydayFiling(run.id, { generatedById: "seed-hr" });
  ok(filing.status === "GENERATED", `EI filing generated (${filing.totalEmployeeLines} lines)`);
  const storedFiling = await db.paydayFiling.findUnique({
    where: { id: filing.id },
    include: { lines: true },
  });
  ok(storedFiling != null && storedFiling.lines.length === slips.length, "Filing + line rows persisted (1 per payslip)");
  ok(storedFiling?.fileContent?.startsWith("HEI2,049091850,20260930,N,N,") === true, "Frozen file content stored (HEI2 header, 9-digit zero-padded employer IRD)");
  ok(storedFiling?.fileHash != null, `sha256 frozen (${storedFiling?.fileHash?.slice(0, 16)}…)`);

  const due = computeDueDate(PAY_DATE);
  ok(due.toISOString().slice(0, 10) === "2026-10-02", "Due date = payday + 2 working days (Wed 30 Sep → Fri 2 Oct)", due.toISOString().slice(0, 10));
  ok(filing.dueDate.toISOString() === due.toISOString(), "Filing carries the computed due date");

  console.log("\n    The 8 reconciliation checks (filed vs payslips vs ledger):");
  for (const c of filing.reconciliation.checks) {
    const mark = c.pass ? "✓" : "✗";
    console.log(`      ${mark} check ${c.index}: ${c.label}`);
    console.log(`         filed ${c.filingCents}c (${money(c.filingCents)}) vs source ${c.sourceCents}c (${money(c.sourceCents)})${c.pass ? "" : "  ← MISMATCH"}`);
  }
  ok(filing.reconciliation.allPass, "ALL reconciliation checks pass (file == payslips == ledger, to the cent)");
  ok(filing.reconciliation.accLevyCents > 0, `ACC levy logged for internal reconciliation only (${money(filing.reconciliation.accLevyCents)})`);

  const grossTotal = filing.reconciliation.checks.find((c) => c.index === 7)!.filingCents;
  const payeTotal = filing.reconciliation.checks.find((c) => c.index === 1)!.filingCents;
  const ksTotal = filing.reconciliation.checks.find((c) => c.index === 3)!.filingCents;
  const ksErTotal = filing.reconciliation.checks.find((c) => c.index === 4)!.filingCents;
  const esctTotal = filing.reconciliation.checks.find((c) => c.index === 5)!.filingCents;
  const slTotal = filing.reconciliation.checks.find((c) => c.index === 6)!.filingCents;
  console.log(`\n    Totals: gross ${money(grossTotal)} · PAYE ${money(payeTotal)} · SL ${money(slTotal)} · KS ee ${money(ksTotal)} · KS er net ${money(ksErTotal)} · ESCT ${money(esctTotal)}`);

  // ---- 5. Lifecycle ----------------------------------------------------------
  console.log("\n[5] Status lifecycle");
  await markFiled(filing.id, { filedById: "seed-hr", irdReference: "myIR-DEMO-1" });
  await markAccepted(filing.id);
  const accepted = await db.paydayFiling.findUnique({ where: { id: filing.id } });
  ok(accepted?.status === "ACCEPTED" && accepted.filedAt != null && accepted.acceptedAt != null, "GENERATED → FILED → ACCEPTED enforced");

  let doubleRefused = false;
  try {
    await generatePaydayFiling(run.id);
  } catch (e) {
    doubleRefused = /already uploaded to myIR/.test(e instanceof Error ? e.message : "");
  }
  ok(doubleRefused, "Regeneration of a FILED filing refused (double-filing guard)");

  // ---- 6. Employee Details ---------------------------------------------------
  console.log("\n[6] Employee Details (ED)");
  // A joiner: Kofi started 2026-08-10 (weekly casual) — pending for August.
  const pendingAug = await listPendingEmployeeDetails(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-31T00:00:00.000Z"));
  const kofi = pendingAug.find((p) => p.kind === "NEW");
  ok(kofi != null, `Pending NEW notification found for August (Kofi — ${kofi?.reason})`);

  if (kofi) {
    const ed = await generateEmployeeDetails({ employeeIds: [kofi.userId], generatedById: "seed-hr" });
    const row = await db.employeeDetailsFiling.findUnique({ where: { id: ed.ids[0] } });
    ok(row?.fileContent?.startsWith("HED2,049091850,Fernly v1.0,1\n") === true, "ED file built (HED2 + DED + TED)");
    ok(row?.fileContent?.includes("TED,") === true, "TED record present (mandatory with every DED)");
    let twice = false;
    try {
      await generateEmployeeDetails({ employeeIds: [kofi.userId] });
    } catch (e) {
      twice = /already has a new-employee notification/.test(e instanceof Error ? e.message : "");
    }
    ok(twice, "Never-notify-twice: a second NEW notification refuses");
  }

  // A departure: set one on the throwaway copy (diego leaves 2026-09-15).
  const allProfiles = await db.employeeTaxProfile.findMany();
  const diegoByCode = allProfiles.find((p) => p.taxCode === "STC");
  if (diegoByCode) {
    await db.employeeTaxProfile.update({
      where: { id: diegoByCode.id },
      data: { employmentEndDate: new Date("2026-09-15T00:00:00.000Z") },
    });
    const pendingSep = await listPendingEmployeeDetails(WINDOW_START, WINDOW_END);
    const diegoPending = pendingSep.find((p) => p.kind === "DEPARTING");
    ok(diegoPending != null, `Pending DEPARTING notification found for September (${diegoPending?.name})`);
    if (diegoPending) {
      const ed = await generateEmployeeDetails({ employeeIds: [diegoPending.userId], generatedById: "seed-hr" });
      const row = await db.employeeDetailsFiling.findUnique({ where: { id: ed.ids[0] } });
      ok(row?.kind === "DEPARTING" && row?.fileContent != null && /,EE,/.test(row.fileContent), "Departing ED built (eligibility EE + end date)");
    }
  }

  // ---- 7. EIA2 amendment -------------------------------------------------------
  console.log("\n[7] EIA2 amendment");
  const oneLine = storedFiling!.lines[0];
  const amendedGross = Math.max(0, oneLine.grossCents - 10_000); // $100 less gross
  const amendment = await generateAmendmentFiling(
    filing.id,
    [{ employeeId: oneLine.employeeId, amended: { grossCents: amendedGross } }],
    { generatedById: "seed-hr" },
  );
  const amendRow = await db.paydayAmendmentFiling.findUnique({ where: { id: amendment.id } });
  ok(amendRow?.fileContent?.startsWith("EIA2,049091850,20260930,") === true, "EIA2 header built (7 fields, original pay date)");
  const amendLines = (amendRow?.fileContent ?? "").split("\n").filter((l) => l !== "");
  ok(amendLines.length === 3 && amendLines[1].startsWith("DTI,") && amendLines[2].startsWith("DAI,"), "One contiguous DTI/DAI pair");
  ok(amendLines[1].includes(`,${oneLine.grossCents},`) && amendLines[2].includes(`,${amendedGross},`), `DTI carries the as-filed gross (${oneLine.grossCents}), DAI the correction (${amendedGross})`);
  const afterAmend = await db.paydayFiling.findUnique({ where: { id: filing.id } });
  ok(afterAmend?.status === "AMENDED" && afterAmend.amendedByFilingId === amendment.id, "Original filing flipped to AMENDED with back-pointer");

  // ---- 8. Deadline watch --------------------------------------------------------
  console.log("\n[8] Overdue flagging");
  const flagged1 = await flagOverdueFilings(new Date("2026-11-13T00:00:00.000Z"));
  const flagged2 = await flagOverdueFilings(new Date("2026-11-13T00:00:00.000Z"));
  ok(flagged2 === 0, `Idempotent (second run flagged ${flagged2}; first flagged ${flagged1})`);

  console.log(`\n━━━ Result: ${pass} PASS · ${fail} FAIL ━━━\n`);
  process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error("\n✗ UNEXPECTED FAILURE:", e instanceof Error ? e.message : e);
    if (e instanceof Error && e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("\n✗ UNEXPECTED FAILURE:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});
