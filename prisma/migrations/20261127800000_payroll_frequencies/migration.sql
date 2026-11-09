-- P10 (PR-B05 + PR-03's payroll_frequency) — all payroll cadences.
--
-- Every cadence rides ONE PayrollRun row: `frequency` names the cadence,
-- `period` stays the unique human key (monthly "2026-11" unchanged; the new
-- formats "2026-11-A", "2026-W45", "2026-F23", "2026-11-09", "2026-Q4",
-- "2026" are distinct by construction — lib/payroll-windows.ts), and
-- startDate/endDate carry the real window so ordering, YTD attribution,
-- gratuity windows and the leave salary-processed guard compare DATES
-- instead of period strings (lexicographic order breaks chronology across
-- cadences: "2026-W45" sorts after "2026-12" though week 45 precedes
-- December).
--
-- SalaryStructure.frequency filters which employees join a run: one ACTIVE
-- structure per employee, and only structures whose cadence matches the
-- run's (the benchmark's frequency-matched structure assignment). The
-- default MONTHLY keeps every existing row and run byte-identical.

ALTER TABLE "SalaryStructure" ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "PayrollRun" ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "PayrollRun" ADD COLUMN "startDate" TIMESTAMP(3);
ALTER TABLE "PayrollRun" ADD COLUMN "endDate" TIMESTAMP(3);

-- Backfill: every pre-P10 run is monthly — [month start, month end] UTC.
-- Nullable columns + UPDATE (rather than ADD … DEFAULT) so the statement
-- order stays plain and the down path is a pure column drop.
UPDATE "PayrollRun" SET
  "startDate" = make_date(substring("period" from 1 for 4)::int, substring("period" from 6 for 2)::int, 1),
  "endDate" = make_date(substring("period" from 1 for 4)::int, substring("period" from 6 for 2)::int, 1) + interval '1 month - 1 day';
