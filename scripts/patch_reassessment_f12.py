#!/usr/bin/env python3
"""F1.2 — update Fernly_HR_Payroll_Parity_Reassessment.md after the epic
landed: header state, §1 exec summary, §5 L3 matrix row + summary table,
§6 F-R4 resolution note, §7.1 status row, §7.2 sequencing. Run only after
CI is green on the epic commit. Fails loudly on a missing anchor."""

from pathlib import Path

F = Path("/home/z/my-project/kanban/docs/Fernly_HR_Payroll_Parity_Reassessment.md")
src = F.read_text(encoding="utf-8")


def rep(old: str, new: str, label: str, count: int = 1) -> None:
    global src
    assert src.count(old) == count, f"{label}: anchor count = {src.count(old)} (expected {count})"
    src = src.replace(old, new)


CI_RUN = "42217086646"  # GitHub Actions run id for 89c0844
SHA = "89c0844"

# --- 1: header table ---
rep(
    "| Date | 2026-11-06 (evening) · **F1.4 status update appended after the epic landed (§7.1)** |",
    "| Date | 2026-11-06 (evening) · **F1.4 status update appended after the epic landed (§7.1)** · **F1.2 status update appended after the epic landed (§7.1)** |",
    "header date",
)
rep(
    "| Fernly code state | `c68e1c3` (\"feat(payroll): F1.4 attendance→LOP derivation\" @ `534b2f4` + its CI/e2e follow-up fixes) — CI green (run 42206155692) |",
    f"| Fernly code state | `{SHA}` (\"feat(hr): F1.2 leave ledger — append-only entries as the source of truth\", first-commit-clean) — CI green (run {CI_RUN}) |",
    "header state",
)

# --- 2: §1 executive summary ---
rep(
    "1. **Three Phase-1 epics are DONE and verified in code** (not just claimed): holiday-aware working-day math is real and denormalized onto every new leave request and payroll run; attendance records exist with five statuses, HR-only marking, and automatic `ON_LEAVE` derivation from approved leave; and payroll now READS those facts — `createPayrollRun` derives each payslip's loss-of-pay from attendance + unpaid leave with `lopSource` provenance — all pinned by unit + e2e tests.",
    "1. **Four Phase-1 epics are DONE and verified in code** (not just claimed): holiday-aware working-day math is real and denormalized onto every new leave request and payroll run; attendance records exist with five statuses, HR-only marking, and automatic `ON_LEAVE` derivation from approved leave; payroll now READS those facts — `createPayrollRun` derives each payslip's loss-of-pay from attendance + unpaid leave with `lopSource` provenance; and the leave domain's source of truth is now an **append-only `LeaveLedgerEntry`** (GRANT/CARRY/CONSUME/EXPIRE/ADJUST + `isReversal` siblings; `LeaveBalance` demoted to a transactionally-synced derived cache; the QA-1 overdraft guard reads Σ(all deltas) from the ledger) — all pinned by unit + e2e tests.",
    "exec point 1",
)
rep(
    "2. **Coverage moved from 9 → 10 parity, 21 → 23 partial, 41 → 38 missing** of 77 benchmarked families (the F1.4 update adds P7, the attendance/LWP proration family, to Partial). The leave-day and payroll-denominator machinery (L7) and the attendance data foundation (L12) crossed status lines with F1.1/F1.3; the attendance→payroll link (P7) crossed with F1.4.",
    "2. **Coverage moved from 9 → 10 parity, 21 → 24 partial, 41 → 37 missing** of 77 benchmarked families (the F1.2 update moves L3, the append-only ledger family, to Partial). The leave-day and payroll-denominator machinery (L7) and the attendance data foundation (L12) crossed status lines with F1.1/F1.3; the attendance→payroll link (P7) crossed with F1.4; the leave ledger itself (L3) crossed with F1.2.",
    "exec point 2",
)
rep(
    "4. **The highest-value next move is now F1.2 (leave ledger)** — F1.4 landed and CI is green, so the attendance→payroll pipeline is honest end-to-end; the remaining structural debt in the leave domain (mutable balances, `carriedOver` always 0) is the highest-leverage refactor in the plan. It carries a feature-freeze warning (plan §9.1) and folds in F-R4.",
    "4. **The highest-value next move is now F1.5 (component catalog)** — F1.2 landed and CI is green, so the leave domain's balances are ledger-backed with a reversal discipline, and the attendance→payroll pipeline is honest end-to-end. F1.5 carries the salary-component catalog (making `retire+create` one transaction — F-R1 rides along) and unblocks the Phase-2 earning/deduction machinery.",
    "exec point 4",
)
rep(
    "The recommended sequence after F1.4 remains the plan's own: **F1.2 (leave ledger — highest leverage, highest risk) → F1.5 (component catalog) → F1.6 (employment lifecycle)**, with the §6 hygiene items folded into the matching epics. F1.4 itself landed same-day (`534b2f4` + CI fixes through `c68e1c3`, CI green).",
    "The recommended sequence after F1.2 remains the plan's own: **F1.5 (component catalog, F-R1 riding along) → F1.6 (employment lifecycle)**, then Phase 2 as written, with the §6 hygiene items folded into the matching epics. F1.2 itself landed same-day (`89c0844`, first-commit-clean — the ledger migration + backfill, the approve/cancel ledger writes, the F-R4 working-day notice, and the seed's ledger story went in as ONE commit; the pre-existing seed lie it exposed, Yuki's `used = 0` against her APPROVED 1-day request, was fixed inside it).",
    "exec closing",
)

# --- 3: §5 matrix L3 row ---
rep(
    "| L3 | Append-only leave ledger | Leave Ledger Entry | mutable `LeaveBalance` | Missing |",
    "| L3 | Append-only leave ledger | Leave Ledger Entry | **F1.2: `LeaveLedgerEntry` — signed immutable rows (GRANT/CARRY/CONSUME/EXPIRE/ADJUST, `isReversal`), `LeaveBalance` a transactionally-synced derived cache, QA-1 guard = Σ(all deltas), cancel writes reversal siblings, migration backfills + drift-ADJUST rows** — EXPIRE/CARRY writers themselves are Phase-2 (F2.4), encashment consumption is F2.2 | Partial **(was Missing)** |",
    "L3 row",
)

# --- 4: coverage summary table + closing line ---
rep(
    """| Status | Plan (pre-F1.1/F1.3) | At `5ef0dd1` (F1.1+F1.3) | Now (`c68e1c3`, +F1.4) |
| --- | --- | --- | --- |
| Parity | 9 (12%) | 10 | **10** |
| Partial | 21 (27%) | 22 | **23** |
| Missing | 41 (53%) | 39 | **38** |
| Out of scope | 6 (8%) | 6 | 6 |
| **Total** | **77** | **77** | **77** |

The operational middle is still where the gap lives — but three of its floor stones (holiday math, attendance data, and now the attendance→payroll link) are laid; the next structural move is F1.2 (the leave ledger), the highest-leverage refactor in the plan.""",
    f"""| Status | Plan (pre-F1.1/F1.3) | At `5ef0dd1` (F1.1+F1.3) | At `c68e1c3` (+F1.4) | Now (`{SHA}`, +F1.2) |
| --- | --- | --- | --- | --- |
| Parity | 9 (12%) | 10 | 10 | **10** |
| Partial | 21 (27%) | 22 | 23 | **24** |
| Missing | 41 (53%) | 39 | 38 | **37** |
| Out of scope | 6 (8%) | 6 | 6 | 6 |
| **Total** | **77** | **77** | **77** | **77** |

The operational middle is still where the gap lives — but four of its floor stones (holiday math, attendance data, the attendance→payroll link, and now the leave ledger) are laid; the next structural move is F1.5 (the component catalog), which unblocks Phase 2's earning/deduction machinery.""",
    "coverage table",
)

# --- 5: §6 F-R4 resolution note ---
rep(
    "| F-R4 | B | **Notice check uses calendar days** though the `LeavePolicy` comment promises working days; `daysBetween(today, start) < minNoticeDays` counts weekends/holidays | `hr-leave.ts: createLeaveRequest` vs schema comment L764 |",
    "| F-R4 | B | **Notice check uses calendar days** though the `LeavePolicy` comment promises working days; `daysBetween(today, start) < minNoticeDays` counts weekends/holidays — **Addressed by F1.2**: notice now counts working days in (today, start], holiday-aware (near starts widen the holiday read by one day; far starts keep the F1.1 read scope via the 3N+1 guarantee) | `hr-leave.ts: createLeaveRequest` vs schema comment L764 |",
    "F-R4 row",
)

# --- 6: §7.1 F1.2 status row ---
rep(
    "| F1.2 Leave ledger | Not started | No `LeaveLedgerEntry` anywhere; `carriedOver` always 0. **Highest leverage, highest risk — feature-freeze leave during the epic** (plan §9.1). Fold in F-R4 (notice days → working days) |",
    f"| F1.2 Leave ledger | **DONE** (`{SHA}`, first-commit-clean, CI green run {CI_RUN}) | `LeaveLedgerEntry` (append-only: GRANT/CARRY/CONSUME/EXPIRE/ADJUST + `isReversal`, polymorphic sourceType/sourceId, migration `20261120000000_leave_ledger` + `down.sql`); `LeaveBalance` = derived cache re-synced by absolute set inside every ledger-writing transaction; QA-1 guard reads the ledger projection (Σ all deltas); approve → one CONSUME row, cancel → its reversal sibling (nets to zero); backfill writes GRANT/CARRY/CONSUME + drift-ADJUST rows (deterministic ids); pure `lib/leave-ledger.ts` 100% covered; seed mirrors production math (26 GRANT + 4 CONSUME/reversal rows; invariant `used == −ΣCONSUME` verified on the seeded DB); all existing leave e2e green unchanged — the epic's acceptance bar. **F-R4 folded in** (notice = working days, holiday-aware). Fixed on the way: the seed's Yuki `used=0` lie (a real invariant violation once the ledger exists) |",
    "7.1 F1.2 row",
)

# --- 7: §7.2 sequencing ---
rep(
    """1. ~~**F1.4** (size S)~~ — **DONE** (`534b2f4`, CI green at `c68e1c3`). F-R15's fold-in was scoped down as planned: the payroll side ignores non-working-day marks; the attendance-form server guard (reject/mark-warn on non-working days) stays deferred.
2. **F1.2** (size M) — the leave ledger refactor, with F-R4 riding along. **Next up.**
3. **F1.5** (size M) — component catalog, with F-R1 (transactional structure save) riding along.
4. **F1.6** (size S) — employment lifecycle fields.""",
    f"""1. ~~**F1.4** (size S)~~ — **DONE** (`534b2f4`, CI green at `c68e1c3`). F-R15's fold-in was scoped down as planned: the payroll side ignores non-working-day marks; the attendance-form server guard (reject/mark-warn on non-working days) stays deferred.
2. ~~**F1.2** (size M)~~ — **DONE** (`{SHA}`, first-commit-clean, CI green). The leave ledger refactor landed with F-R4 riding along (notice = working days); the leave-side transactional-writes discipline (the standing F-R2/F-R12 task) is now the house pattern for every ledger-writing action.
3. **F1.5** (size M) — component catalog, with F-R1 (transactional structure save) riding along. **Next up.**
4. **F1.6** (size S) — employment lifecycle fields.""",
    "7.2 sequencing",
)

F.write_text(src, encoding="utf-8")
print("patched reassessment doc OK —", len(src), "bytes")
