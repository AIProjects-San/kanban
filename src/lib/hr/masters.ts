// ---------------------------------------------------------------------------
// P2.1 (ADR-022) — the HR master resolvers: the ONE shared seam every
// write path uses to keep EmployeeProfile's denormalized string mirrors
// and its master FKs in lockstep.
//
// The mirror rule (profile.department / jobTitle / grade strings):
//   department  = master.code ?? master.name   (the legacy enum keys
//                 "ENGINEERING"… ride in `code`, so Phase 1/2 string
//                 readers — payroll analytics, the CSV exports — see the
//                 exact bytes they always did)
//   jobTitle    = designation.name
//   grade       = grade.name
//
// Two resolution modes, by caller:
//   • ensure*  — find-or-create (the legacy free-form paths: the P33
//     quick change, offer onboarding, the G6 documents' string inputs —
//     masters grow organically exactly like the free strings did).
//   • find*    — must exist (the master-picker paths send real ids; an
//     unknown id is a stale form, refused with a friendly error).
//
// Every resolver takes the caller's Prisma client (db OR the interactive
// transaction's tx) — the tx-hygiene rule forbids touching the global db
// inside a transaction callback, and these resolvers are called from
// inside them.
// ---------------------------------------------------------------------------

import type { Prisma } from "@prisma/client";

type Client = Prisma.TransactionClient;

export interface MasterRef {
  id: string;
  /** The profile string this master mirrors to. */
  mirror: string;
}

/** Department mirror: code (the legacy enum key) when set, else name. */
function departmentMirror(d: { code: string | null; name: string }): string {
  return d.code ?? d.name;
}

/** Find a department by id — the master-picker path (must exist). */
export async function findDepartmentById(
  tx: Client,
  id: string,
): Promise<MasterRef | null> {
  const d = await tx.department.findUnique({ where: { id }, select: { id: true, code: true, name: true } });
  return d ? { id: d.id, mirror: departmentMirror(d) } : null;
}

/** Find-or-create a department by its code-or-name — the legacy enum path.
 * The P33/enum callers only ever send the four canonical keys, so the
 * create branch is bounded (idempotent by code/name). */
export async function ensureDepartmentByKeyOrName(
  tx: Client,
  keyOrName: string,
): Promise<MasterRef> {
  const existing = await tx.department.findFirst({
    where: { OR: [{ code: keyOrName }, { name: keyOrName }] },
    select: { id: true, code: true, name: true },
  });
  if (existing) return { id: existing.id, mirror: departmentMirror(existing) };
  const created = await tx.department.create({
    data: { name: keyOrName, code: null },
    select: { id: true, code: true, name: true },
  });
  return { id: created.id, mirror: departmentMirror(created) };
}

/** Find a designation by id — the master-picker path. */
export async function findDesignationById(
  tx: Client,
  id: string,
): Promise<MasterRef | null> {
  const d = await tx.designation.findUnique({ where: { id }, select: { id: true, name: true } });
  return d ? { id: d.id, mirror: d.name } : null;
}

/** Find-or-create a designation by name — the free-form title paths. */
export async function ensureDesignationByName(tx: Client, name: string): Promise<MasterRef> {
  const existing = await tx.designation.findUnique({ where: { name }, select: { id: true, name: true } });
  if (existing) return { id: existing.id, mirror: existing.name };
  const created = await tx.designation.create({ data: { name }, select: { id: true, name: true } });
  return { id: created.id, mirror: created.name };
}

/** Find a grade by id — the master-picker path. */
export async function findGradeById(
  tx: Client,
  id: string,
): Promise<MasterRef | null> {
  const g = await tx.grade.findUnique({ where: { id }, select: { id: true, name: true } });
  return g ? { id: g.id, mirror: g.name } : null;
}

/** Find-or-create a grade by name — the free-form ladder-string paths.
 * A backfill-created level is a high placeholder (existing levels are
 * never renumbered); HR reorders in the masters UI. */
export async function ensureGradeByName(tx: Client, name: string): Promise<MasterRef> {
  const existing = await tx.grade.findUnique({ where: { name }, select: { id: true, name: true } });
  if (existing) return { id: existing.id, mirror: existing.name };
  const max = await tx.grade.aggregate({ _max: { level: true } });
  const created = await tx.grade.create({
    data: { name, level: (max._max.level ?? 0) + 10 },
    select: { id: true, name: true },
  });
  return { id: created.id, mirror: created.name };
}

/** Pure band check for the Grade editor: both bounds non-negative and
 * min <= max when both are set (null = open-ended on that side). */
export function gradeBandError(minBase: number | null | undefined, maxBase: number | null | undefined): string | null {
  if (minBase != null && minBase < 0) return "The salary band's minimum cannot be negative.";
  if (maxBase != null && maxBase < 0) return "The salary band's maximum cannot be negative.";
  if (minBase != null && maxBase != null && minBase > maxBase) {
    return "The salary band's minimum cannot exceed its maximum.";
  }
  return null;
}
