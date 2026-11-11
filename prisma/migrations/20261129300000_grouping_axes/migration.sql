-- P34 (EM-03) — the employee grouping axes: grade, employment type and
-- branch on EmployeeProfile.
--
-- The benchmark's Employee master carries branch / grade / employment-type
-- grouping axes so every employee list can be org-sliced (EM-03's key
-- feature). Fernly's translation keeps the three as plain profile facts,
-- QA-19 style: '' = not classified yet (rendered as "—"), never a fabricated
-- default. The directory's filter chips are the slicing surface.
--
--   • grade — free-form ladder string ("L4"); the benchmark's Employee
--     Grade MASTER (EM-09) stays a later epic — this is the field, and the
--     P33 property-history registry registers it at P34 as planned.
--   • employmentType — controlled vocabulary (FULL_TIME / PART_TIME /
--     CONTRACT / INTERN / CONSULTANT), validated at the zod boundary.
--   • branch — a plain string per the plan entry (no master, no
--     validation beyond length; workspaces name their own offices).
--
-- Additive only: no existing column changes, no backfill (pre-P34 profiles
-- read as unclassified — the honest empty), zero behavior change until HR
-- classifies someone.

ALTER TABLE "EmployeeProfile" ADD COLUMN "grade" TEXT NOT NULL DEFAULT '';
ALTER TABLE "EmployeeProfile" ADD COLUMN "employmentType" TEXT NOT NULL DEFAULT '';
ALTER TABLE "EmployeeProfile" ADD COLUMN "branch" TEXT NOT NULL DEFAULT '';

-- The directory's employment-type filter chip slices on this column (the
-- department and employmentStatus axes carry the same index discipline).
CREATE INDEX "EmployeeProfile_employmentType_idx" ON "EmployeeProfile"("employmentType");
