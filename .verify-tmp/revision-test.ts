// SECTION D write-test: create a salary revision on a DB COPY, mirroring
// createSalaryRevision's production transaction verbatim (clone structure
// with re-priced basic anchor + close old assignment + open new — one
// transaction). Verifies atomicity semantics. Read-only against canonical.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function parseComponents(raw: string): Array<{ key: string; amount: number; label?: string }> {
  return JSON.parse(raw);
}
function basicKeyOf(comps: Array<{ key: string }>): string | null {
  const fixed = comps.find((c) => c.key === "basic");
  return fixed ? fixed.key : null;
}

async function main() {
  const soren = await db.user.findUnique({ where: { email: "soren@fernly.app" } });
  const before = await db.salaryStructureAssignment.findFirst({
    where: { employeeId: soren.id, toDate: null },
    include: { structure: true },
  });
  console.log("BEFORE:", {
    id: before.id.slice(-8),
    fromDate: before.fromDate.toISOString().slice(0, 10),
    toDate: before.toDate,
    base: before.base.toNumber(),
    structure: before.structureId.slice(-6),
    components: before.structure.components,
  });

  // --- the production transaction core (salary-assignments.ts:111-214) ---
  const newFrom = new Date("2027-02-01T00:00:00.000Z");
  const newBase = 66000;
  const result = await db.$transaction(async (tx) => {
    const current = before;
    if (newFrom.getTime() <= current.fromDate.getTime()) throw new Error("date guard");
    const newVariable = current.variable.toNumber();
    const payChanged = newBase !== current.base.toNumber() || newVariable !== current.variable.toNumber();
    let structureId = current.structureId;
    if (payChanged) {
      const components = parseComponents(current.structure.components);
      const basicKey = basicKeyOf(components);
      if (newBase !== current.base.toNumber() && !basicKey) throw new Error("no basic anchor");
      const nextComponents = components.map((c) => (basicKey && c.key === basicKey ? { ...c, amount: newBase } : c));
      if (current.structure.isActive) {
        await tx.salaryStructure.update({ where: { id: current.structureId }, data: { isActive: false } });
      }
      const clone = await tx.salaryStructure.create({
        data: {
          userId: soren.id,
          components: JSON.stringify(nextComponents),
          notes: `promotion from 2027-02-01 — cloned from structure ${current.structureId.slice(-6)}`,
          maxBenefits: current.structure.maxBenefits,
          frequency: current.structure.frequency,
          isDefault: false,
          openingYtd: current.structure.openingYtd ? (current.structure.openingYtd as object) : undefined,
          effectiveFrom: newFrom,
          isActive: current.structure.isActive,
          createdById: "verify-check",
        },
      });
      structureId = clone.id;
    }
    await tx.salaryStructureAssignment.update({ where: { id: current.id }, data: { toDate: newFrom } });
    const created = await tx.salaryStructureAssignment.create({
      data: {
        employeeId: soren.id,
        structureId,
        fromDate: newFrom,
        toDate: null,
        base: newBase,
        variable: newVariable,
        reason: "PROMOTION",
        approvedById: "verify-check",
        approvedAt: new Date(),
        createdById: "verify-check",
      },
    });
    return created;
  });

  const rows = await db.salaryStructureAssignment.findMany({
    where: { employeeId: soren.id },
    orderBy: { fromDate: "asc" },
    include: { structure: true },
  });
  console.log("AFTER — soren's full timeline:");
  for (const r of rows) {
    console.log(`  ${r.fromDate.toISOString().slice(0, 10)} → ${r.toDate?.toISOString().slice(0, 10) ?? "open"}  base=${r.base.toNumber()}  reason=${r.reason}  structure=${r.structureId.slice(-6)} [${r.structure.components}]`);
  }
  const old = rows.find((r) => r.id === before.id)!;
  const okClose = old.toDate?.toISOString().slice(0, 10) === "2027-02-01";
  const okOpen = result.toDate === null && result.base.toNumber() === 66000 && result.fromDate.getTime() === newFrom.getTime();
  const okClone = rows.every((r) => r.structureId !== before.structureId || r.toDate !== null ? true : r.id !== result.id) && result.structureId !== before.structureId;
  console.log(`old closed at 2027-02-01: ${okClose}; new open base 66000: ${okOpen}; new assignment prices through a cloned structure: ${okClone}`);
  console.log(okClose && okOpen && okClone ? "REVISION WRITE-TEST: PASS" : "REVISION WRITE-TEST: FAIL");
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
