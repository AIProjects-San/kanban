# Fernly — Roadmap

The engineering backlog, by phase. Each entry states its priority and how it
gets picked up. Anything not listed here is either shipped or recorded as an
ADR/decision in `docs/DECISIONS.md`. Production-readiness residuals live in
`docs/PRODUCTION_READINESS.md` §6 — this file is the forward plan.

---

## P2 — HR masters, parity hardening & honest gates

P2 is the parity/hardening phase that follows the NZ statutory Phase 1/2
work. Its shape: the employee master's grouping axes move from free strings
to real masters (Department / Designation / Grade), the remaining
benchmark-parity gaps close, and the coverage debt the statutory phases
accumulated is paid down as those same files are touched.

| # | Item | Priority | Notes |
|---|---|---|---|
| P2.1 | Department / Designation / Grade masters (schema + EmployeeProfile FK migration + admin UI + transfer/promotion FK references) | **P2** | In flight — the highest-value P2 item. `EmployeeProfile.department/jobTitle/grade` strings become FKs; strings stay temporarily as denormalized mirrors (dual-write) until every read path is migrated, then drop in a follow-up. |
| P2.2 | Close server-actions coverage gap to **92% statements / 85% branches** | **P2** | ADR-021 (`docs/DECISIONS.md`) reset the gate to an honest 89/77 baseline after the 90/80 gate ran continuously red through the Phase 1/2 statutory work. Pick up organically as P2 work touches Phase 1/2 files — the remaining shortfall is concentrated in payroll self-service, salary-structure assignments, loans, offboarding, employment-docs and tax admin wrappers. Raise the `vitest.config.ts` gate whenever the measured state clears the next step; never lower it again. |

---

## P2.5 — candidate scope (reported, not committed)

Items surfaced by smoke tests but explicitly deferred for a scope decision
before any work starts. Nothing here is scheduled. Source: the G5 CSV
import smoke test (2026-11-15, manual attendance path — device `CSV_IMPORT`,
3+1 employees × 5 days imported, reconciled, paid through a W46 run).

| # | Item | Source |
|---|---|---|
| P2.5.1 | **CSV re-upload has no retract/replace semantics.** The punches import is insert-only with re-delivery dedup: deleting a row from the CSV and re-uploading reports "0 inserted, N duplicates" and the already-imported punch persists — the exception queue cannot flag the missing entry (verified live). A corrected export cannot retract a bad punch; there is no UI to delete/re-import a device window's punches. (The queue DOES flag genuinely incomplete data — a lone IN punch surfaces as a missing-OUT exception.) | CSV smoke test |
| P2.5.2 | **`addPayslip` has no UI.** The server action exists (and is guarded), but the Payroll view offers no way to add a missed employee to an OPEN run — the only UI path is deleting the run (blocked when it consumed adjustments) and recreating it. | CSV smoke test (payroll leg) |
| P2.5.3 | Minor UX: the punches CSV import reuses the punch-log page's device *filter* as its import target (documented in the panel text, but easy to miss); the mapping/punch templates are paste-only ("Insert template" + placeholder) with no downloadable file. | CSV smoke test |
