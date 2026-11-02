-- QA audit round 3, QA-19 — EmployeeProfile.department used to default to
-- 'ENGINEERING', so any profile created without an explicit department
-- (self-service create path, HR create without picking one) showed up in
-- the shared roster as "Engineering" — an HR-owned classification nobody
-- had asserted. The default is now '' ("not classified yet", rendered as
-- "—"; the admin schema accepts '' alongside the four real departments).
--
-- Existing rows keep their stored value; only future inserts change.
ALTER TABLE "EmployeeProfile" ALTER COLUMN "department" SET DEFAULT '';
