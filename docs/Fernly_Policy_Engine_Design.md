# Fernly Policy Engine & Purity Design

**Business rules as pure functions, organization policy as data**

| | |
| --- | --- |
| Document | `docs/Fernly_Policy_Engine_Design.md` |
| Date | 2026-11-08 |
| Status | Design — the leave-policy half (§4) **landed as F2.4** (2026-11-08; see Appendix C as-built). The payroll half (§5) lands with F2.3/F2.8/F3.3; §7's module map is the M-track's target shape (files live under `src/lib/` until M1–M4 move them). Companion to `Fernly_Domain_Modules_Architecture_Plan.md` (structure) and `Fernly_HR_Payroll_Enhancement_Plan.md` (epics); this document defines *how business logic is expressed* in the four modules so that organizations differ by **rows in the database, not branches in the code** |
| Directive | "All modules should have pure code functions. Some business logic can be configurable from db like different deductions from net salary, number of leaves, holiday dates etc. Think all this business logic. Also some organizations allow leaves in negative i.e. take advanced leaves and add them monthly, some organization deposit all leaves after completion of a year of service etc." (2026-11-08) |
| Fernly code state | `1fdc6a7` (`origin/main`; Phase 1 complete, parity matrix + module plan landed) |
| Benchmark | Frappe HR (`frappe/hrms`) @ `88161025` — the matrix rows this design consumes are cited inline (`LV-*`, `PR-*`, `EM-16`) |
| Companion docs | `Fernly_Domain_Modules_Architecture_Plan.md` (module charters, §6 contracts), `Fernly_HR_Payroll_Enhancement_Plan.md` (epics F2.1–F3.10), `Fernly_HRMS_Feature_Parity_Matrix.md` (row-level truth), `DECISIONS.md` (ADR-014/ADR-015 statutory declination) |

---

## 1. Purpose and Scope

The modularization plan fixed **where code lives** (four domain modules over a shared kernel). This design fixes **how logic is expressed** inside them, through two laws:

1. **Law 1 — business logic is pure functions** (§2.1): every rule that decides something — leave balance guards, allocation amounts, deduction math — is a deterministic function of *(facts, policy, dates)*, free of I/O, clock, and randomness.
2. **Law 2 — policy is data** (§2.2): every number an organization can disagree about — leave quotas, accrual strategy, negative-leave allowance, deduction modes, holiday dates — is a row in the database, edited through the existing admin surfaces, never a code constant.

The directive's named examples land as follows:

| Directive example | Design section | Config surface | Epic |
| --- | --- | --- | --- |
| Different deductions from net salary | §5 | `SalaryComponent` calc modes + `PayAdjustment` carriers | F2.3 (+ F2.8, F3.3) |
| Number of leaves | §4.1–§4.2 | `LeavePolicy` allocation strategy block | F2.4 (expanded) |
| Holiday dates | §6 | `HolidayCalendarEntry` — **already DB-driven since F1.1** | — |
| Negative / advance leave, added monthly | §4.3 | `allowNegative` + `negativeFloor` + `EARNED` strategy | F2.4 |
| All leaves deposited after a year of service | §4.2 (Org C) | `AFTER_SERVICE` strategy + `minServiceMonths` | F2.4 |

**Non-goals.** No user-visible behavior change from this document alone — every new column ships with a default equal to today's semantics (§8). No user-authored formula sandbox, no statutory engines, no per-employee policy assignment documents (benchmark `Leave Policy Assignment`, LV-03 — stays Partial; §10.4). All existing ADR boundaries stand.

---

## 2. The Two Laws

### 2.1 Law 1 — business logic is pure functions

**Definition.** A *rule* is an exported function in `src/modules/<m>/rules/**` (and, until the M-track moves them, the equivalent `src/lib` kernels) that is:

- **deterministic** — same inputs, same output, always;
- **side-effect free** — no Prisma, no fetch, no session, no outbox, no audit writes;
- **clock-free** — never reads `Date.now()` / `new Date()`; the caller injects `asOf` (a `"YYYY-MM-DD"` string or an explicit period, the house convention `lop-derivation.ts` already proves);
- **randomness-free** — no `Math.random()`; any tie-breaking is policy, not dice.

Services — the other half of every module — do **all** the I/O: load facts, load policy, call rules, transact, audit, notify. The split is *rules decide, services obey*. The architecture plan's §6.3 slice already sketches this; this design makes it a hard rule with enforcement (§9).

**What this costs and buys.** Rules become trivially unit-testable without a database (the 106-file suite already demonstrates this on the existing kernels), policy changes never require code changes, and a future "what-if" preview (compute a payslip or balance under a draft policy) is a function call, not a staging environment.

**Already pure today** (verified at `1fdc6a7`): `leave-ledger.ts`, `working-days.ts`, `lop-derivation.ts`, `payroll-math.ts`, `offer-math.ts`, `employment.ts`, `hierarchy.ts`.

**Not yet pure — the extraction backlog** (lands with the M-track / F2.4, no behavior change):

| Inline logic today | Location | Becomes |
| --- | --- | --- |
| The overdraft guard `request.days > projection.available` (plus its request-time twin) | `hr-leave.ts` (~L342, ~L470) | `hr/rules/leave-guard.ts` — `assertWithinBalance(requested, projection, policy)` |
| Balance-materialization decision (grant annualDays lazily on first use) | `hr-shared.ts` `getOrCreateBalance` | `hr/rules/allocation.ts` — `dueGrants(policy, employment, year, asOf) → GrantOp[]` |
| PayAdjustment import/consume decision | `payroll.ts` (F2.3 when it lands) | `account/rules/adjustments.ts` |
| Advance recovery installments | F2.8 when it lands | `account/rules/recovery.ts` — `recoverySchedule(advance, rule) → PayAdjustment[]` |

### 2.2 Law 2 — policy is data

**Definition.** Code owns the **strategy space**: the enums, zod schemas, and rule functions that say *what can be configured and what each choice means*. The database owns the **instance**: which strategy each leave type uses, which amount each component carries, which dates are holidays. An organization differs from another by rows, not by branches.

**The test for "is this policy or code?"** — *rules of the product vs. choices of the organization*:

| Stays code (product invariants) | Becomes/ Stay data (organization choices) |
| --- | --- |
| Status transition maps (`PENDING → APPROVED/REJECTED/…`) | Leave quotas, accrual strategy, negative floor |
| The permission matrix (RBAC floor) | Deduction components, amounts, calc modes, caps |
| Append-only ledger discipline; reversal semantics | Holiday dates, half-day flags |
| Purity law itself; audit-writer contract | Encashment knobs; FnF/gratuity slabs |
| Money is `Float` + `round2` (ADR/risk-2 house style) | Notice periods, probation defaults, min-service gates |

**Policy resolution.** There is exactly one workspace, so there is no scope tree to resolve. Resolution is per-record and cheap:

```
LeaveType + LeavePolicy row          → ResolvedLeavePolicy   (zod-parsed, defaulted)   → hr rules
SalaryComponent catalog + structure  → ResolvedStructure     (snapshot at write time)  → account rules
Workspace row + typed settings keys  → OrgSettings           (typed accessor)          → guardrails
```

Each module owns a `policy.ts` — a loader that reads its master-data rows and returns the zod-validated, default-filled policy object rules consume (§7). Loaders are services (they touch Prisma); the objects they return are plain data.

**Snapshot discipline (money freezes, leave explains).** The payslip already freezes resolved lines (`Payslip.earnings/deductions` JSON — F1.5's discipline): a policy edit never rewrites a locked run. Leave needs no freeze because the ledger *is* the explanation: every allocation writes a `GRANT` row with `sourceType "POLICY"` and a deterministic `sourceId` (§4.5), so any balance is auditable against the policy that produced it, after the fact, forever.

---

## 3. Policy Records and Resolution Map

| Policy record | Owning module | Prisma model (state at `1fdc6a7`) | Consumed by (rule) |
| --- | --- | --- | --- |
| Leave type flags | hr | `LeaveType` — exists (paid, requiresDoc) | `lop-derivation` (already) |
| Leave allocation & guards | hr | `LeavePolicy` — exists (annualDays, maxCarryOver, minNoticeDays, maxConsecutiveDays); **gains the strategy block (§4.1)** | `allocation.ts`, `leave-guard.ts` |
| Holiday calendar | hr | `HolidayCalendarEntry` — exists (date unique, label, isHalfDay, kind) | `working-days.ts` (already) |
| Salary components | account | `SalaryComponent` — exists (kind, mode, defaultAmount, sortOrder); **mode set grows (§5.1)** | `offer-math` / `payroll-math` |
| Pay adjustments | account | `PayAdjustment` — F2.3 | `adjustments.ts` |
| Advance recovery | account | `EmployeeAdvance` — F2.8 | `recovery.ts` |
| FnF / gratuity slabs | account | FnF policy fields + `GratuityRule` — F2.1 / F3.3 | `fnf.ts`, `gratuity.ts` |
| Workspace guardrails | admin | `Workspace` typed settings keys (§5.4) | `deductions.ts` guardrail |
| Offer/approval knobs | joining | `OfferRecord` expiry + approval step — F2.10 | `offer-math` |

Admin owns the *framework* (typed settings, the settings UI pattern), never the semantics — the same split the architecture plan's §4.2 charter draws.

---

## 4. Leave Policy Engine (hr)

### 4.1 The strategy space

`LeavePolicy` grows one **allocation strategy block**. One leave type = one strategy (the 1:1 `LeaveType ↔ LeavePolicy` shape is Fernly's house model; see §10.4).

| Column | Values | Default (= today) | Meaning |
| --- | --- | --- | --- |
| `allocationStrategy` | `MANUAL` \| `ANNUAL_LUMP_SUM` \| `EARNED` \| `AFTER_SERVICE` | `MANUAL` | how entitlement becomes GRANT rows |
| `accrualFrequency` | `MONTHLY` \| `QUARTERLY` \| `HALF_YEARLY` \| `ANNUAL` | `MONTHLY` | EARNED cadence (LV-B02) |
| `allocateOnDay` | `FIRST` \| `LAST` \| `DOJ_DAY` | `FIRST` | day of the period the GRANT lands (LV-B02) |
| `accrualRounding` | `FLOOR_QUARTER` \| `NEAREST` | `FLOOR_QUARTER` | per-period grant rounded to 0.25-day steps (half-day semantics F1.1), floor-biased by default |
| `accrualCap` | Float (null) | null = `annualDays` | max standing entitlement the strategy may build |
| `grantOn` | `PERIOD_START` \| `ANNIVERSARY` | `PERIOD_START` | ANNUAL_LUMP_SUM/AFTER_SERVICE landing day |
| `prorateForJoiners` | Boolean | true | ANNUAL_LUMP_SUM: pro-rata by remaining full months of the calendar year |
| `minServiceMonths` | Int | 0 | AFTER_SERVICE: months of service before the deposit (and, independently, LV-01's *applicable-after* usability gate when > 0) |
| `accrueDuringProbation` | Boolean | true | EARNED/ANNUAL_LUMP_SUM: whether probationers accrue at all |
| `allowNegative` | Boolean | false | advance-leave switch (LV-B06) |
| `negativeFloor` | Float | 0 | how far below zero the balance may go, in days |
| `carryExpiresAfterMonths` | Int (null) | null = never | carried days lapse after N months of the new year (EXPIRE writer) |
| `countHolidaysInLeave` | Boolean | false | holidays inside a range consume leave days (LV-01; today they never do) |

Encashment knobs (`encashable`, `maxEncashableDays`, `nonEncashableDays`) were already specified by F2.2 and ride F2.2 — they are policy of the same shape and land in the same editor.

### 4.2 The three organizations (worked ledger walks)

**Org A — earned monthly, advance allowed** ("take advanced leaves and add them monthly"). Type `ANNUAL`, strategy `EARNED`, `annualDays 24` → 2.0/month, `allocateOnDay FIRST`, `allowNegative true`, `negativeFloor 5`. Employee joins **Mar 10**; ledger (calendar year, the implicit leave period — LV-08):

| Date | Entry | Δ | Available | Note |
| --- | --- | --- | --- | --- |
| Apr 1 | GRANT | +2.0 | 2.0 | `POLICY:u:t:2026:2026-04` |
| May 1 | GRANT | +2.0 | 4.0 | |
| Jun 1 | GRANT | +2.0 | 6.0 | |
| Jun 20 | CONSUME | −8.0 | **−2.0** | 8-day request; guard: 6 − 8 = −2 ≥ −5 → allowed |
| Jul 1 | GRANT | +2.0 | 0.0 | the "added monthly" recovery — pure arithmetic |
| Aug 1 | GRANT | +2.0 | 2.0 | |

No repayment machinery exists or is needed: future GRANTs lift the same Σ-deltas number the guard reads.

**Org B — lump-sum on Jan 1, pro-rated for joiners.** Strategy `ANNUAL_LUMP_SUM`, `annualDays 20`, `grantOn PERIOD_START`, `prorateForJoiners true`, `maxCarryOver 5` (existing knob). Employee joins **Jul 15**:

| Date | Entry | Δ | Note |
| --- | --- | --- | --- |
| Aug 1 | GRANT | +8.0 | `round_floor_0.25(20 × 5/12) = 8.0` (Aug–Dec = 5 full months) |
| Jan 1 (Y+1) | CARRY | +min(unspent, 5) | year-end rollover job (F2.4) |
| Jan 1 (Y+1) | GRANT | +20.0 | full-year deposit; `accrualCap` unbound |

**Org C — deposit all leaves after one year of service.** Strategy `AFTER_SERVICE`, `annualDays 12`, `minServiceMonths 12`, `accrueDuringProbation false` (moot here). Employee joins **Apr 1, 2025**:

| Date | Entry | Δ | Note |
| --- | --- | --- | --- |
| (2025) | — | 0 | no accrual, no allocation — nothing before eligibility |
| Apr 1, 2026 | GRANT | +12.0 | first anniversary: the whole year's leave deposited |
| Apr 1, 2027 | GRANT | +12.0 | re-grant each anniversary; rollover job handles CARRY/EXPIRE independently |

Sick leave stays `MANUAL` (grant-on-first-use, today's behavior) in all three orgs — per-type strategy is the whole point (F2.4's §9.5 decision).

### 4.3 Negative balance (advance leave)

The guard rule changes shape, not the ledger. Today (`hr-leave.ts`): reject when `requested > available`. With policy:

```
reject when  available − requested  <  −negativeFloor          // allowNegative
reject when  requested > available                             // !allowNegative (floor 0 ⇒ identical to today)
```

- The ledger already tolerates negative Σ-deltas by construction (F1.2); `LeaveBalance` cache columns stay honest (`entitled` unchanged, `used` grows past it).
- **Recovery** is arithmetic: monthly EARNED grants (or the next period's deposit) raise `available`; no scheduled-deduction coupling, no payroll side-effect — an advance leave is *days owed to the employer*, docked only if the type is unpaid or the exit FnF encashes a negative balance (F2.1 consumes this).
- **UI**: a negative `available` renders as "3.5 day(s) in advance" instead of a red zero; the request form shows the floor ("you may go up to −5").
- **Alerting** (balance below −⌊floor/2⌋, or un-recovered advance at exit) rides F3.10's reminder engine — policy supplies the threshold, the engine the plumbing.

### 4.4 Carry-forward, expiry, probation

- `maxCarryOver` (exists) caps the CARRY row the year-end job writes; **`carryExpiresAfterMonths`** makes carried days lapse mid-year via an EXPIRE row (negative, entitlement-side — the kernel's documented semantics), so Org B can grant 20 fresh days while 3 stale ones die on Mar 31.
- **Consumption ordering is FIFO** — carry days are spent before current-year grants (reporting splits `carriedOver` vs `entitled` correctly; the guard never cared which days it spent). Rationale in §10.1.
- **Probation interaction**: `accrueDuringProbation false` pauses EARNED accrual until `PROBATION → ACTIVE` (the F1.6 hard gate already publishes this fact); a common org rule that otherwise lands as a hidden code branch.

### 4.5 Engine mechanics (three writers, one truth)

| Writer | Trigger | Idempotency | Epic |
| --- | --- | --- | --- |
| **Lazy materialization** — first balance touch of a (user, type, year) grants what is already due under the strategy | request/approve/queue read paths (today's `getOrCreateBalance` shape) | unique `(userId, leaveTypeId, year, sourceType, sourceId)` — deterministic key `POLICY:<user>:<type>:<year>:<period>` | F2.4 |
| **Cron allocation** — `allocateDue` walks EARNED types on their `allocateOnDay`, writes the period's GRANT rows (matrix LV-J03) | the authenticated cron route (admin's scheduler framework) | same deterministic key; double-run → single row | F2.4 |
| **Year-end rollover** — writes CARRY (≤ `maxCarryOver`) and EXPIRE (cap + `carryExpiresAfterMonths`) rows at the period boundary | same cron, Dec 31 / Jan 1 watermark | per (user, type, year) pair keys | F2.4 |

`dueGrants(policy, employmentFacts, ledgerProjection, asOf)` — the pure rule behind all three — returns the grant ops due *now*; each writer then appends them transactionally. `LeaveBalance` remains exactly what it is today: a derived cache, never an input.

### 4.6 What this closes on the matrix

LV-01 (type knobs — carry expiry, include-holiday, applicable-after), LV-04 (allocation writes ledger rows with own expiry), LV-B02 (frequency/allocate-on/rounding), LV-B06 (allow-negative), LV-B18 (schedule retries — the cron writer's error path), LV-J03 (`allocate_earned_leaves`), LV-08 stays calendar-year Partial by choice (§10.5). LV-02/LV-03 (policy template + assignment) stay Partial by declination (§10.4). Statuses flip only when F2.4 lands.

---

## 5. Payroll Policy (account)

### 5.1 Component calc modes — "different deductions from net salary"

`SalaryComponent.mode` today: `FIXED` | `PERCENT_OF_BASIC`. It grows:

| Mode | Base | Pass | New? |
| --- | --- | --- | --- |
| `FIXED` | absolute monthly = annual ÷ 12 | 1 | — |
| `PERCENT_OF_BASIC` | % × resolved basic | 1 | — |
| `PERCENT_OF_GROSS` | % × gross (Σ earnings) | 1 | **yes** |
| `PERCENT_OF_NET` | % × running net | 2 (sequential, `sortOrder`) | **yes** |
| LOP line | gross × lopDays ÷ workingDays | system-managed (`lop` key, F1.1/F1.4) | — |

**Pass semantics (documented, no fixed-point iteration).** Pass 1 computes earnings → `gross`, then all gross/basic-based deductions (order-independent). Pass 2 walks `PERCENT_OF_NET` deductions **in `sortOrder`, sequentially**, each on the net remaining after everything before it. Worked example — gross 10,000, basic 5,000, fixed deduction 1,000, net-percenters 10% then 5%:

```
pass 1:  gross 10,000 → fixed −1,000 → net₀ 9,000
pass 2:  10% × 9,000 = 900 → net 8,100 ; 5% × 8,100 = 405 → net 7,695
```

Sequential (not proportional, not iterated) is the declared semantics — deterministic, explainable on the payslip, one line of documentation instead of a solver. Rationale recorded in §10.2. Percent-of-net components are visually flagged in the structure editor so HR cannot compose them by accident.

### 5.2 The four deduction carriers

"Different deductions from net salary" is four distinct mechanisms, all policy:

| Carrier | Configured on | Model | Hits net | Epic |
| --- | --- | --- | --- | --- |
| Standing deduction | the employee's structure (picked from catalog) | `SalaryStructure` JSON snapshot | every run | F1.5 ✅ |
| Catalog default | component master | `SalaryComponent.defaultAmount`, `mode` | at structure-edit time | F1.5 ✅ |
| One-off adjustment | the adjustment record | `PayAdjustment` (PENDING → CONSUMED) | next OPEN run | F2.3 |
| Recurring recovery | the advance's recovery rule | `PayAdjustment` schedule (installments + final true-up) | each run until settled | F2.8 |

### 5.3 Advance recovery schedule (pure rule)

`recoverySchedule(advance, { installment, startPeriod, capPercentOfNet }) → PayAdjustment[]` — e.g. a 1,200 advance recovered at 300/period yields four PENDING adjustments; if `capPercentOfNet` binds in a lean month the installment defers and the schedule lengthens (never silently truncates). Each row carries `sourceType "ADVANCE"` + `sourceId` — the universal-adapter provenance F2.3 specifies. The *rule* is pure; the *run import* is a service.

### 5.4 Guardrail (optional, default off)

One typed workspace setting: `payroll.maxDeductionPercentOfGross` (null = today's behavior — net may go negative and the slip says so). When set, run creation emits a visible per-slip warning (audit + UI), never a silent clamp — honesty over magic (ADR-014's spirit; the declined statutory engines stay declined, F3.4/ADR-015 untouched).

### 5.5 Full-and-final config (F2.1) and gratuity (F3.3)

FnF gains policy fields, all DB: encashment **rate basis** (`GROSS_OVER_WORKING_DAYS` — the F2.2 default — vs `BASIC_OVER_30`), notice-shortfall recovery formula toggle, and (F3.3) the gratuity slab table (`years → fraction` × final average earnings, non-statutory disclaimer mandatory). The FnF statement itself stays a computed snapshot (EM-16's lite scope).

### 5.6 Snapshot discipline (unchanged, now load-bearing)

A locked run is frozen policy: structure edits create a *new* revision (F-R1 retire-on-revision), catalog edits never rewrite existing slips, PayAdjustment consumption is one-way. The purity of `payroll-math` is what makes "re-simulate under a corrected input" (F3.1 arrears-lite) a function call on stored inputs.

---

## 6. Holidays and Calendar (hr)

Already DB-driven since F1.1 — `HolidayCalendarEntry` (unique date, label, half-day, kind `PUBLIC/WEEKLY_OFF`), CRUD at `hr:admin`, consumed by `working-days.ts`, denormalized into `PayrollRun.workingDays`. The directive's "holiday dates" example is therefore **satisfied as-is**; this design adds exactly one knob: `LeavePolicy.countHolidaysInLeave` (default false = today — a holiday inside a leave range consumes no leave days; LV-01's `include_holiday`). Weekly-off pattern stays code-level Mon–Fri (working-days) — moving it to data is F3.5's shift-work concern, not this one. Regional/multi-calendars stay declined (single-workspace product, D-M2/M6 territory).

---

## 7. Module Landing Map

| File | Module | Contains | Lands with |
| --- | --- | --- | --- |
| `rules/allocation.ts` | hr | `dueGrants`, strategy math (proration, rounding, true-up, caps) | F2.4 |
| `rules/leave-guard.ts` | hr | `assertWithinBalance` (negative floor aware) | M1 (extract, today's semantics) → F2.4 (floor) |
| `rules/carry.ts` | hr | rollover CARRY/EXPIRE computation | F2.4 |
| `policy.ts` | hr | `resolveLeavePolicy(type, policyRow) → ResolvedLeavePolicy` | M1 shell → F2.4 fields |
| `rules/deductions.ts` | account | two-pass mode resolution + guardrail check | F2.3 |
| `rules/adjustments.ts` | account | PayAdjustment import/consume decisions | F2.3 |
| `rules/recovery.ts` | account | `recoverySchedule` | F2.8 |
| `policy.ts` | account | catalog/structure resolution | M2 shell → F2.3 modes |
| `policy.ts` | joining | offer/approval/probation knobs | F2.10 |
| `services/config` | admin | typed `OrgSettings` keys (`payroll.maxDeductionPercentOfGross`) | F2.3 |

Every new rule file ships with property-style tests (accrual sums to `annualDays` exactly — quarter-day floor plus final-period true-up; guard rejects exactly at floor+ε; deduction passes are order-deterministic).

---

## 8. Rollout — zero-behavior defaults

Every column in §4.1/§5.1 defaults to today's semantics, so the migration is additive `ALTER TABLE`s + seed defaults — no backfill, no data repair, no flag day:

| Migration | Columns | Behavior delta on deploy |
| --- | --- | --- |
| `leave_policy_strategy` | the §4.1 block on `LeavePolicy` | none — `MANUAL` + `allowNegative false` + floor 0 + `countHolidaysInLeave false` reproduce current guards exactly |
| `salary_component_modes` | mode value set (no DDL; zod + editor) | none — existing modes unchanged |
| `workspace_money_settings` | `payroll.maxDeductionPercentOfGross` (null) | none — guardrail off |

UI surfaces: the existing leave-type editor (hr:admin) grows a "Strategy" section; the component editor (payroll:manage) grows the mode select with the percent-of-net flag; the settings page gains the guardrail field. The preview seed scripts grow one Org-A/B/C demo row each so the strategies are visible on the demo workspace.

---

## 9. Purity Enforcement (spec — lands with M0 fences)

`eslint.config.mjs`, extending the module fences already specified (architecture plan §7.1):

```js
// Purity fences — Fernly_Policy_Engine_Design.md §9: rules decide, services obey
{ files: ["src/modules/*/rules/**", "src/lib/{leave-ledger,working-days,lop-derivation,payroll-math,offer-math,employment,hierarchy}.ts"],
  rules: {
    "no-restricted-imports": ["error", { patterns: [
      { group: ["@prisma/client", "**/db", "**/repo", "@/modules/*/services/**", "@/server-actions/**", "next/**"],
        message: "rules are pure — no Prisma, no services, no transport" } ] }],
    "no-restricted-properties": [{ names: ["now"], object: "Date", message: "inject asOf — rules never read the clock" },
                                 { names: ["random"], object: "Math", message: "rules are deterministic" }],
    "no-restricted-globals": ["error", { name: "fetch", message: "rules are pure" }],
  } },
```

Conventions that lint cannot check, review does: every rule takes `asOf`/period explicitly; dates cross the service boundary as `"YYYY-MM-DD"`; policy objects are zod-parsed before rules see them; unknown enum values fail closed (strategy parse error ⇒ treat as `MANUAL` + audit? — no: **fail the request loudly**, §10.6).

---

## 10. Open Questions for Review

1. **Consumption ordering FIFO vs proportional.** Recommend FIFO (carry spent first): matches intuition, keeps `carriedOver`/`entitled` reporting honest, zero ledger changes. Proportional only matters if encashment rates differ per bucket — they don't (F2.2 one rate).
2. **PERCENT_OF_NET: sequential vs proportional.** Recommend sequential (§5.1): one documented rule, payslip-explainable, no solver. Alternative (proportional single-pass over pre-net-deduction base) is marginally fairer between components but needs a spec paragraph nobody reads.
3. **Negative-recovery deadline** (advance must clear within N months / at exit). Recommend deferring any hard deadline to F3.10 alerting; a hard auto-deduction of day-debt into payroll would couple hr days to account money against the modules' stated direction (time facts flow down, money never writes time).
4. **LV-02/LV-03 (policy templates + per-employee assignments).** Recommend keeping the declination: per-type strategy + service-date-driven math covers the directive's organizations; assignment documents would add a submittable layer for one workspace's worth of users.
5. **Leave period named windows (LV-08).** Recommend staying calendar-year (implicit) — one workspace, one timezone, no window-switching UI to build; revisit only with multi-entity (D-M2 stands).
6. **Unknown/legacy policy values on read.** Recommend fail-loud (zod error surfaces as the action's typed error) over silent `MANUAL` fallback — a corrupt policy row should stop the request, not quietly change entitlement math.

---

*Every Fernly fact above was verified against the working tree at `1fdc6a7` (schema, kernels, guards, config read in full); every benchmark claim cites `Fernly_HRMS_Feature_Parity_Matrix.md` @ `88161025`. This design changes no matrix status — F2.4/F2.3/F2.2/F2.1/F2.8/F3.3 will, when they land.*

---

## Appendix C — As-built record (F2.4, 2026-11-08)

The leave-policy engine (§4) landed as epic F2.4. Where the build refined the design:

| Design (§) | As built | Why |
| --- | --- | --- |
| `hr/rules/allocation.ts` + `hr/rules/leave-guard.ts` + `hr/rules/carry.ts` (§7 map) | one pure kernel `src/lib/leave-policy.ts` (all three rule families) + the I/O-wrapping job core `src/lib/leave-allocation-core.ts` | the M-track has not moved files yet (§7's map is the target shape); one kernel keeps the rule matrix in a single test file, and the design's own §2.1 split (rules decide / services obey) is preserved — the job core is the service |
| `POLICY:<user>:<type>:<year>:<period>` source keys (§4.5) | `sourceType "POLICY"` + `sourceId` = the bare period key (`"2026-04"`, `"2026-Q1"`, `"2026"`, `"carry"`, `"carry-expire"`, `"carry-lapse"`) — uniqueness comes from the (user, type, year) ledger scope, not the key string | shorter, matches the F1.2 sourceId conventions readers already know; the MANUAL legacy path keeps its type-id sourceId byte-for-byte |
| Lazy materialization grants "everything due" (§4.5) | unchanged for strategies; MANUAL keeps the legacy single full-year GRANT (single `.create`, legacy note) byte-identically | the zero-behavior-rollout rule (§8) applies to MANUAL too — existing rows/tests pin the old shape |
| The engine's three writers (§4.5) | lazy writer only ever runs when the balance row is MISSING; the cron's grant phase only when it EXISTS (rollover creates the new-year row) — plus idempotency keys on both | closes the lazy-vs-cron race the design left implicit |
| EARNED first period under `allocateOnDay: DOJ_DAY` | grants on the join day itself; under FIRST/LAST the hire month is skipped (a partial month never accrues) | the conservative reading of "employed on or before the landing moment" — pinned in the kernel tests |
| ANNUAL_LUMP_SUM + PERIOD_START for a mid-year joiner | the grant's due DATE is the hire date (pro-rated or not) — a Dec 1 joiner must not wait for a Jan 1 they were not employed for | caught by the rule matrix; the design only specified the pro-rated amount |
| `monthsIntoYear` | counts COMPLETE months (a 3-month carry expiry lapses on April 1st) | the design's "N months of the new year elapsed" read precisely |
| LV-B07 as an independent gate (§4.1 note) | `checkServiceEligibility` runs at submission for every strategy when `minServiceMonths > 0`; AFTER_SERVICE also uses the knob as its deposit threshold | one knob, two honest consumers — as the design specified |
| §10 open questions | Q1 FIFO consumption: landed (carry spent first, `carryLapseDelta`); Q2/Q3/Q4/Q5/Q6: unchanged, decided when F2.3/F2.2 land | only the leave-policy questions were in F2.4's scope |

Everything else landed as written: the strategy space (§4.1), the guard shape (§4.3), the three organizations' ledger walks (§4.2 — the kernel tests walk them), the fail-loud enum pick (§10.6), the additive zero-behavior migration (§8), and the seeded demo type.
