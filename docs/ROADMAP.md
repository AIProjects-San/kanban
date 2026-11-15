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
before any work starts. Nothing here is scheduled.

| # | Item | Source |
|---|---|---|
| P2.5.x | *(to be filled as gaps are reported)* | — |
