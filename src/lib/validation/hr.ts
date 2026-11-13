// ---------------------------------------------------------------------------
// HR schemas — the holiday calendar, attendance records, the employee
// directory (admin + self-service), performance reviews, the employment
// lifecycle + structured changes, onboarding checklists + template,
// offboarding/exit interviews/full-and-final, the skill master + maps, and
// employee identification documents.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, isoDateStr } from "./common";


// ---------------------------------------------------------------------------
// F1.1 — holiday calendar (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
// One entry per date; kind is labeling (both kinds exclude the date from
// working-day counting). Label is optional — a bare date is a valid off-day.
// ---------------------------------------------------------------------------

export const holidayEntrySchema = z.object({
  id: cuidish.optional(),
  date: isoDateStr,
  label: z.string().trim().max(80).default(""),
  kind: z.enum(["PUBLIC", "WEEKLY_OFF"]).default("PUBLIC"),
  isHalfDay: z.boolean().default(false),
}).strict();

export const deleteHolidayEntrySchema = z.object({
  id: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// F1.3 — attendance records (docs/Fernly_HR_Payroll_Enhancement_Plan.md
// §7.1). One record per user per date; HR/admin marking only
// (attendance:manage — decision §9.1: no member self-marking). The form
// schema deliberately EXCLUDES ON_LEAVE: that status is derived server-side
// from approved leave and can never be submitted. inTime/outTime are
// optional "HH:mm" clock strings (the <input type="time"> native format);
// when both are present, outTime must be after inTime.
// ---------------------------------------------------------------------------

const hhmmStr = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:mm (24-hour clock).");

export const attendanceRecordSchema = z.object({
  id: cuidish.optional(),
  userId: cuidish,
  date: isoDateStr,
  status: z.enum(["PRESENT", "ABSENT", "HALF_DAY", "WFH"]),
  inTime: hhmmStr.nullable().optional(),
  outTime: hhmmStr.nullable().optional(),
  note: z.string().trim().max(500).default(""),
}).strict().refine(
  (v) => !(v.inTime && v.outTime && v.outTime <= v.inTime),
  "Out time must be after in time.",
);

export const deleteAttendanceRecordSchema = z.object({
  id: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// HR module feature 2 — employee directory (docs/HR_MODULE_PLAN.md §5).
// `notes` is HR-only and excluded from the self-service schema on purpose.
// ---------------------------------------------------------------------------

const isoDateish = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be yyyy-mm-dd.")
  // QA-10b: the regex alone accepts impossible dates ("2026-02-30",
  // "9999-99-99") which only exploded later at the Prisma write with a
  // generic "unexpected failure". Reject them at the schema boundary.
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Date must be a real calendar date.")
  .nullable()
  .optional();

export const employeeProfileSchema = z.object({
  jobTitle: z.string().trim().max(100).optional(),
  // QA-19: "" is the "not classified yet" value (roster renders "—") — the
  // admin path may save a profile without picking a department. Every other
  // unknown string stays rejected.
  department: z.enum(["ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"]).or(z.literal("")).optional(),
  // P34 (EM-03) — the grouping axes, same QA-19 ""-is-unclassified rule.
  // grade/branch are free-form (the plan's "plain branch string"; the grade
  // MASTER is EM-09's later epic); employmentType is the controlled
  // vocabulary (lib/config EMPLOYMENT_TYPE_KEYS) — an unknown key is
  // rejected, never silently blanked.
  grade: z.string().trim().max(64, "Grade is at most 64 characters.").optional(),
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"]).or(z.literal("")).optional(),
  branch: z.string().trim().max(64, "Branch is at most 64 characters.").optional(),
  hireDate: isoDateish,
  // P25 (PL-02/EM-J01) — the birthday engine's input (date-only semantics,
  // HR-owned like hireDate; null clears it — no birthday, no reminder).
  birthDate: isoDateish,
  phone: z.string().trim().max(40).optional(),
  location: z.string().trim().max(100).optional(),
  emergencyContactName: z.string().trim().max(100).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  skills: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
  // F1.6 — the three PLAIN employment facts are HR-editable here; the
  // STATUS itself is deliberately NOT in this schema (.strict() rejects
  // it): employmentStatus is only writable through the guarded
  // transitionEmployment action (§9.3 hard gate + audit), never a plain
  // profile save.
  probationEndsAt: isoDateish,
  // S14 (EM-B04/LV-B13) — the leave-approver override (null clears it).
  leaveApproverId: cuidish.nullable().optional(),
  noticePeriodWeeks: z
    .number({ message: "Notice period must be a number of weeks." })
    .int("Notice period must be a whole number of weeks.")
    .min(0, "Notice period cannot be negative.")
    .max(52, "Notice period cannot exceed 52 weeks.")
    .nullable()
    .optional(),
  lastWorkingDay: isoDateish,
}).strict();

export const employeeProfileAdminSchema = employeeProfileSchema; // notes included above

// QA-10: self-service may only edit CONTACT fields — job data (jobTitle,
// department, hireDate, notes — and, since P34/EM-03, the grade /
// employmentType / branch grouping axes) is HR-owned per
// docs/HR_MODULE_PLAN.md §5
// ("Self-service edit of own contact fields; HR/ADMIN edit everything").
// Before this schema existed the self-service action accepted jobTitle /
// department / hireDate, so any member could self-certify "CTO" in the
// shared directory. .strict() rejects any attempt to smuggle HR-owned
// keys through the self-service path.
export const employeeProfileSelfSchema = z.object({
  phone: z.string().trim().max(40).optional(),
  location: z.string().trim().max(100).optional(),
  emergencyContactName: z.string().trim().max(100).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  skills: z.string().trim().max(500).optional(),
}).strict();

// ---------------------------------------------------------------------------
// HR module feature 3 — performance reviews (docs/HR_MODULE_PLAN.md §6).
// ---------------------------------------------------------------------------

export const createReviewSchema = z.object({
  userId: cuidish,
  title: z.string().trim().min(1, "Title is required.").max(200),
  periodStart: isoDateStr,
  periodEnd: isoDateStr,
  // F1.6 — probation cycles satisfy the §9.3 hard gate once reviewed;
  // omitted keeps the pre-existing STANDARD behavior.
  kind: z.enum(["STANDARD", "PROBATION"]).optional(),
}).strict();

// F1.6 — employment lifecycle transition input (transitionEmployment).
// target is never "": un-classifying is not a transition (one-way — EXITED
// is terminal, and "not tracked" is only the implicit starting state).
export const employmentTransitionSchema = z.object({
  target: z.enum(["PROBATION", "ACTIVE", "SUSPENDED", "EXITED"]),
  probationEndsAt: isoDateish,
  lastWorkingDay: isoDateish,
}).strict();

// P33 (EM-06/EM-01, F2.5-lite) — the promotion/transfer change input
// (applyEmploymentChange). Every property is optional: the change records
// exactly what it moves (the writer refuses an empty diff); raisePercent
// is the shape-preserving revision (FIXED earnings scale, percent lines
// ride the grown basis); managerId null clears the reporting line.
export const employmentChangeSchema = z.object({
  kind: z.enum(["PROMOTION", "TRANSFER"]),
  effectiveDate: isoDateStr,
  jobTitle: z.string().trim().max(100).optional(),
  department: z.string().trim().max(64).optional(),
  // P34 (EM-03) — grade is promotable: the P33 property-history registry
  // registered it the moment the field landed ("L3" → "L4" rides the
  // structured diff like any other property). Free-form ladder string,
  // "" = unclassified (rendered "—" in the diff).
  grade: z.string().trim().max(64, "Grade is at most 64 characters.").optional(),
  managerId: z.string().trim().max(64).nullable().optional(),
  raisePercent: z
    .number()
    .finite()
    .min(0.5, "A raise needs at least half a percent.")
    .max(100, "A raise cannot exceed 100%.")
    .optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

export const selfAssessmentSchema = z.object({
  reviewId: cuidish,
  selfAssessment: z.string().trim().max(10_000),
  selfRating: z.number().int().min(1, "Rating must be 1-5.").max(5, "Rating must be 1-5.").optional(),
}).strict();

/** Shared id-carrier for the single-id transitions (submit / acknowledge). */
export const reviewDecisionSchema = z.object({
  reviewId: cuidish,
}).strict();

/** Manager decision: comment + 1-5 rating on a SUBMITTED cycle. */
export const decideReviewSchema = z.object({
  reviewId: cuidish,
  managerComment: z.string().trim().min(1, "A comment is required.").max(10_000),
  managerRating: z.number().int().min(1, "Rating must be 1-5.").max(5, "Rating must be 1-5."),
}).strict();

// ---------------------------------------------------------------------------
// HR module feature 4 — onboarding (docs/HR_MODULE_PLAN.md §7).
// ---------------------------------------------------------------------------

export const createChecklistSchema = z.object({
  newHireId: cuidish,
  title: z.string().trim().min(1, "Title is required.").max(200),
  useTemplate: z.boolean().default(true),
  // F2.1 — the same machinery carries separation checklists; the default
  // keeps every existing caller on the onboarding side.
  kind: z.enum(["ONBOARDING", "SEPARATION"]).default("ONBOARDING"),
  // P35 (EM-12) — the working-day-walk anchor for the instantiated tasks'
  // due dates. Optional: the profile's hireDate (ONBOARDING) / lastWorkingDay
  // (SEPARATION) is the default, today when neither fact exists.
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Start date must be yyyy-mm-dd.").optional(),
}).strict();

export const addTaskSchema = z.object({
  checklistId: cuidish,
  title: z.string().trim().min(1, "Task title is required.").max(200),
  assigneeId: cuidish.nullable().optional(),
  dueOffsetDays: z.number().int().min(0).max(365).optional(),
  // P35 (EM-12) — the required flag rides manual adds too.
  isRequired: z.boolean().default(false),
}).strict();

export const taskDoneSchema = z.object({
  taskId: cuidish,
  done: z.boolean(),
}).strict();

// F2.10 (F-R8) — the configurable onboarding-template source
// (OnboardingTemplateTask CRUD, onboarding:manage).
// P35 (EM-12/EM-B06) — user-XOR-role assignee + the required flag.
export const saveOnboardingTemplateTaskSchema = z.object({
  id: cuidish.optional(),
  kind: z.enum(["ONBOARDING", "SEPARATION"]),
  title: z.string().trim().min(1, "Task title is required.").max(200),
  dueOffsetDays: z.number().int().min(1).max(365),
  assignSelf: z.boolean().default(false),
  // P35 — pin ONE user (validated against the roster at the action layer)
  // XOR scope the task to a role key (every holder sees it).
  assigneeUserId: cuidish.nullable().optional(),
  assigneeRole: z.enum(["ADMIN", "MANAGER", "HR", "MEMBER"]).nullable().optional(),
  isRequired: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(999).optional(),
}).strict().refine(
  (d) => !(d.assigneeUserId && d.assigneeRole),
  { message: "Pick either one user or one role for the assignee — not both." },
);

export const deleteOnboardingTemplateTaskSchema = z.object({
  id: cuidish,
}).strict();

// ---------------------------------------------------------------------------
// F2.1 — offboarding & full-and-final lite
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2).
// ---------------------------------------------------------------------------

export const exitInterviewCreateSchema = z.object({
  userId: cuidish,
}).strict();

export const exitInterviewScheduleSchema = z.object({
  interviewId: cuidish,
  scheduledAt: isoDateStr,
  interviewerId: cuidish.optional(),
  notes: z.string().trim().max(10_000).optional(),
}).strict();

export const exitInterviewCompleteSchema = z.object({
  interviewId: cuidish,
  notes: z.string().trim().max(10_000).optional(),
}).strict();

export const exitInterviewCancelSchema = z.object({
  interviewId: cuidish,
}).strict();

export const fnfGenerateSchema = z.object({
  userId: cuidish,
}).strict();

export const fnfSettleSchema = z.object({
  userId: cuidish,
}).strict();

// -------------------------------------------------------------------------
// P37 (EM-19, PF-07, EM-18) — the skill master + employee skill maps.
// -------------------------------------------------------------------------

export const saveSkillSchema = z.object({
  id: cuidish.optional(),
  key: z.string().trim().min(1, "A key is required.").max(60).regex(/^[a-z0-9_]+$/, "Lowercase letters, digits and underscores only."),
  label: z.string().trim().min(1, "A label is required.").max(120),
  description: z.string().trim().max(500).default(""),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9_999).default(0),
}).strict();

export const deleteSkillSchema = z.object({
  id: cuidish,
}).strict();

export const upsertEmployeeSkillSchema = z.object({
  userId: cuidish,
  skillKey: z.string().trim().min(1).max(60),
  rating: z.number().int().min(1, "Rating must be 1-5.").max(5, "Rating must be 1-5."),
  notes: z.string().trim().max(2_000).default(""),
}).strict();

export const removeEmployeeSkillSchema = z.object({
  id: cuidish,
}).strict();

// -------------------------------------------------------------------------
// P36 (EM-21) — employee identification documents (the DocumentTypeConfig
// scope axis + the EmployeeDocument lifecycle).
// -------------------------------------------------------------------------

export const requestEmployeeDocumentSchema = z.object({
  userId: cuidish,
  docTypeKey: z.string().trim().min(1).max(60),
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

export const submitEmployeeDocumentSchema = z.object({
  documentId: cuidish,
  // A reference to the submitted file (URL / name) — optional in v1.
  fileRef: z.string().trim().max(500).default(""),
}).strict();

export const verifyEmployeeDocumentSchema = z.object({
  documentId: cuidish,
  remarks: z.string().trim().max(2_000).default(""),
}).strict();

export const rejectEmployeeDocumentSchema = z.object({
  documentId: cuidish,
  // Required — the member needs to know what to fix.
  remarks: z.string().trim().min(1, "A rejection note is required.").max(2_000),
}).strict();

// ---------------------------------------------------------------------------
// P1 G6 — the Employee Transfer / Employee Promotion documents (the
// approval-gated, effective-dated employment changes). Create takes the
// to-side only (the from-side is snapshotted server-side from the live
// profile); submit/approve/cancel/effect address an existing document by
// kind + id. The status graph and date rules live in
// lib/hr/employment-documents.ts — these schemas only bound the shapes.
// ---------------------------------------------------------------------------

/** A department key the transfer may move to (controlled vocabulary — the
 * runtime re-checks against DEPARTMENT_LABELS for the friendly error). */
const departmentKey = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine(
    (k) => ["ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"].includes(k),
    "Unknown department.",
  );

export const createEmployeeTransferSchema = z.object({
  employeeId: cuidish,
  effectiveDate: isoDateStr,
  toDepartment: departmentKey.optional(),
  toJobTitle: z.string().trim().min(1).max(120).optional(),
  /** null (or "") = clear the reporting line; undefined = leave untouched. */
  toManagerId: z.string().trim().max(64).nullable().optional(),
  toLocation: z.string().trim().min(1).max(120).optional(),
  reason: z.string().trim().max(2_000).optional(),
}).strict();

export const createEmployeePromotionSchema = z.object({
  employeeId: cuidish,
  effectiveDate: isoDateStr,
  /** Required — a promotion always names the new designation (spec §4:
   * it must differ from the current one; the action refuses same-title). */
  toJobTitle: z.string().trim().min(1).max(120),
  toGrade: z.string().trim().min(1).max(60).optional(),
  reason: z.string().trim().max(2_000).optional(),
  /** Optional pointer at a Phase 1B SalaryStructureAssignment belonging to
   * the same employee (validated at write time; never acted on). */
  linkedSalaryAssignmentId: cuidish.optional(),
}).strict();

export const employmentDocumentRefSchema = z.object({
  kind: z.enum(["TRANSFER", "PROMOTION"]),
  id: cuidish,
}).strict();

export const cancelEmploymentDocumentSchema = employmentDocumentRefSchema.extend({
  reason: z.string().trim().max(2_000).optional(),
}).strict();
