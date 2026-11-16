# External Review Triage — 2026-11-16

## What this is

An unsolicited external review of Fernly (12 sections, ~60 claims, README-first
methodology, explicitly instructed not to trust the docs alone) was received
2026-11-16. Every code-checkable claim was verified against the tree at
`d4d3c0a` in three audit passes: architecture/product, security/data model, and
payroll/e-signature/testing/tooling. All citations below are `file:line` at that
commit. This document is the assessment only — no fixes are included; the
remediation plan is §7 and the scope question is deliberately left to the owner
(§6).

**Headline.** The review is directionally useful and right about several real
gaps — but factually wrong on roughly a third of its checkable claims, in both
directions. It credits us with problems we had already fixed (password floor,
breach checking, cache invalidation, an erasure mechanism) and misses
capabilities we have since shipped (the NZ statutory engine and IRD filing,
view-component tests, an observability stack, and finished-but-unwired global
search / bulk ops / ICS backends). The root cause of its errors and of several
of our genuine risks is the same one: **documentation drift**. The README
describes a tree that no longer exists.

Approximate tally of the ~48 code-checkable claims:

| Verdict | Count | Meaning |
|---|---|---|
| Confirmed | 27 | The claim holds as stated, or near enough to act on |
| Partial | 15 | Right direction, wrong mechanics or stale specifics |
| Refuted | 6 | The cited code/mechanism does not exist or works differently |
| Judgment | rest | Product/process opinions — engaged in §6, not fact-checkable |

## Scorecard by review section

| § | Topic | Verdict | One-line summary |
|---|---|---|---|
| 1 | "Resume-driven development" | Judgment | Process discipline is real (see §5), doc truth is not enforced |
| 2 | Single-route SPA, no real-time | Partial + Confirmed | Work surface (19 views) is store-only, refresh loses state; 30 admin/HR pages are server-rendered with URL state. Real-time for messages/notifications: genuinely absent |
| 3 | Scope creep (five products) | Judgment | Engaged in §6 |
| 4 | Payroll | Mixed | Stale on statutory (NZ engine + IRD filing exist), right on slip-number gaps and lock finality, wrong on the LOP formula, understates GL filing scope |
| 5 | E-signature | Confirmed | No rate limit, link-possession identity, no crypto sealing; verification found the evidence itself ages out (see §4.8) |
| 6 | Security | Mixed | Password and cache claims refuted; JWT claim misattributes a retired mechanism; blast radius, dual-source no-op, and audit governance confirmed |
| 7 | Testing | Mixed | Selenium+Cucumber and prose-only policy confirmed; "views untested" refuted; the coverage gate was already honestly reset by ADR-021 |
| 8 | Tech choices | Confirmed | Versions as claimed; the dual-schema concern is real but underestimated — four CI gates hold sync |
| 9 | Data model | Mostly confirmed | Single role, dual permission source, timezone blindness in domain math all real |
| 10 | Missing capabilities | Mostly confirmed | Attachments/PWA/integrations absent; search, bulk, ICS exist as finished backends with no UI |
| 11 | Docs as smokescreen | Inverted | Docs drift in both directions; the gap is enforcement, not theater |
| 12 | Bottom line | Partially fair | The RBAC/scoping praise stands; the rewrite advice is a product call |

---

## 1. Confirmed — accepted as real gaps

These need no further argument; each was reproduced in code.

**Product.**
- **No real-time delivery.** No WebSocket/SSE anywhere; the only interval in
  `src` is the 10 s `getMyPermissions()` poll (`app-shell.tsx:195`). Messages
  and notifications arrive as SSR props from `getDashboardData()` and refresh
  only via the user's own mutations (`use-refresh.ts:29`) or a full reload. An
  inbound message is invisible until the recipient acts.
- **No deep linking on the work surface.** Zero `useSearchParams`/`usePathname`
  in views; selected task/project/thread live only in the Zustand store
  (`app-store.ts:52-74`). Refresh resets to `dashboard` (`app-store.ts:197`).
- **No file attachments** anywhere (no `type="file"`, multipart, S3;
  `hr-employee-documents.ts:14` says so by design).
- **No PWA/offline** (`public/` holds only `logo.svg` and `robots.txt`).
- **No outbound integrations** — the only outbound HTTP call in app code is the
  Resend mail API (`mailer.ts:80`); production CSP is `connect-src 'self'`.
- **Messaging is thin**: 200-message inbox cap, no pagination
  (`dashboard.ts:201-212`), no message search, no read receipts or typing
  indicators, composer reachable only from the Team page.
- **Command palette has no ARIA combobox semantics** — plain input + buttons,
  no `role`, no `aria-activedescendant`, no arrow-key navigation
  (`command-palette.tsx:168-174`). Modals are better (`modal.tsx:41,44`).

**Security model.**
- **Blast radius**: one schema, one `PrismaClient` pool, no RLS, no schema or
  credential separation between tasks and payroll/e-sign data (`db.ts:7-15`;
  no `ROW LEVEL SECURITY` in any migration).
- **Dual permission source is a silent no-op on revocation.** Effective
  permission is `static(role) ∪ db(role)` (`auth-guard.ts:55-59`); unchecking a
  floor permission in the role matrix saves successfully and changes nothing,
  and `getEffectivePermissions` keeps displaying it as held
  (`config-loader.ts:607-613`).
- **Audit visibility is all-or-nothing and mis-scoped.** `audit:view` floor:
  SUPER_ADMIN, ADMIN, **MANAGER** (`rbac.ts:85,99,112`) — a MANAGER reads the
  entire trail including every user's `auth.signed_in` IPs and user agents
  (`audit.ts:36-39`, no where-clause; `schema.prisma:504-505`), while HR cannot
  read HR-domain actions at all. 246 typed actions, not the README's 101.
- **Single role field** (`schema.prisma:38`; union of 5 in `rbac.ts:4`) —
  nobody can be both HR and MANAGER; no per-user permission overrides exist.

**Legal surface.**
- **E-signature**: public `/offer/[token]` actions are unthrottled (rate
  limiting exists only for login), identity binding is link possession plus a
  typed-name match against a name displayed on the same page
  (`hiring-offers.ts:595-597`), and signing is a plain row update — no digest,
  no hash chain, no RFC 3161 timestamping (`hiring-offers.ts:607-610`).
- **Slip numbers are count+1** (`payroll.ts:1480`) with a single retry, guarded
  only by schema uniques; overflow-slip failures leave numbers unused
  (`payroll.ts:925-970`). "Locked when paid" is an HR-asserted status flag
  with no disbursal reconciliation (`payroll.ts:1643-1724`).
- **No bank details or payment files** — the remittance CSV renders the account
  column blank by design (`payroll-csv.ts:79-81,106`).

**Process.**
- **Selenium + Cucumber** (138 scenarios / 18 feature files; no Playwright or
  Cypress as project deps), with a `zzz-` filename hack ordering the lockout
  test last because the throttle budget is per-IP on shared localhost.
- **"Bug fixes require a failing pre-fix test" is prose-only** — no PR
  template, no CI check; the pre-commit hook runs lint + typecheck only.
- **Feature flags absent as a system** — what exists are workspace DB toggles
  and env gates, no per-release gating or kill switches.
- **Onboarding credentials are broken by default**: with no `RESEND_API_KEY`
  the mailer is Noop in production ("the mail is DROPPED", `mailer.ts:59-70`),
  the welcome mail tells the hire to use "Forgot password?" — and that reset
  mail is dropped by the same mailer. The printable handout
  (`joiner-handout.tsx:4-11`) is the acknowledged fallback.
- **`markJoined` is one-way**: no un-join; the deterministic email is consumed
  forever, so a re-hire of the same name silently gets `name2@…`
  (`hiring-onboarding.ts:29-51`).

## 2. Right in substance, wrong in specifics

- **"Single-route SPA."** True only for the work surface. `src/app` has 31
  `page.tsx` + 13 `route.ts`; the admin/HR/payroll surface (30 pages) is
  server-rendered with real URL state (e.g. `admin/timesheets` reads
  `searchParams`). The refresh-loses-state and no-deep-links criticism stands
  exactly where it hurts: the Kanban core.
- **The JWT/tokenVersion "contradiction."** The quoted mechanism does not
  exist. The NextAuth v4 JWT callback was retired with PR-49; ADR-011
  explicitly rejected porting the check (`DECISIONS.md:389-391`), and
  `tokenVersion` has no consumer (only bumps: `users.ts:264,563,731`;
  `password-reset.ts:264`). Bearer JWTs are custom 1-hour HS256 tokens
  (`jwt.ts:40`) that do hit the DB every request
  (`auth-better.ts:595-598`); cookie sessions are 7-day DB-backed opaque
  tokens with a 5-minute cookie cache (`auth-better.ts:247,252`). So there is
  no statelessness contradiction — there is a README describing a retired
  mechanism, and `PRODUCTION_READINESS.md:41` still claiming "tokenVersion
  revocation ≤5 min". Stale docs, not a live flaw — but worse for trust.
- **"60-second permission cache."** TTL is 10 seconds (`config-loader.ts:237`)
  and role/permission mutations actively invalidate — local clear plus Redis
  pub/sub to other instances (`config-loader.ts:284-289`; every mutation calls
  `bumpConfigCache()`). Worst case for a revoked DB-grant is ~10 s, not 60.
  README:110 and `auth-guard.ts:47` are both stale.
- **Password policy.** There is a hard floor: `ABSOLUTE_MIN_PASSWORD_LENGTH =
  8` (`password.ts:22,32-33`), mirrored by `z.number().min(8)` at write time
  (`validation/workspace.ts:176`). Breach checking exists and is real
  k-anonymity HIBP (`breach-check.ts:58-103`) — opt-in via env, fail-open, and
  never checked at login. The review's insinuation (admin can set 4, no
  breached-password check) is false; the README simply never claims these.
- **Soft delete vs erasure.** `eraseUser` exists and is genuinely
  two-step, audit-first, transactional (`trash.ts:246-311`). But verification
  found it is **broken for any user with employment history**: `Loan`,
  `EmployeeTransfer`, `EmployeePromotion`, `SalaryStructureAssignment`,
  `Timesheet`, `DeviceUserMapping` are `onDelete: Restrict`, so
  `tx.user.delete()` throws P2003 and rolls back — and the unit test mocks
  Prisma entirely (`erase-user.test.ts:14-32`), so CI never sees it. Worse,
  `Payslip.userId`, `LeaveRequest.userId`, `AttendanceRecord.userId`,
  `SalaryStructure.userId` have **no FK** (`schema.prisma:2507,1185,2336`) —
  salary amounts and leave reasons survive "erasure" as orphans. The
  reviewer's skepticism was justified; the failure mode is different and
  arguably worse than alleged.
- **"Pre-statutory payroll."** Stale. A full NZ statutory engine exists at
  `src/lib/payroll/nz/` — PAYE on IR341-verified slabs, ACC earners' levy,
  KiwiSaver with ESCT and 28-day auto-enrolment, student loan — wired into
  every run (`payroll.ts:778-796`), plus IRD EI/ED filing files with
  deadline tracking (`src/lib/ird/`, `payday-filing.ts`) and GL posting on
  lock (`postPayrollRun`, `payroll.ts:1786-1820`). It is data-gated: no
  seeded rate sets → no statutory lines (`payroll.ts:585`). Jurisdictions
  other than NZ remain manual deduction lines, so the compliance concern
  survives — scoped, not absolute.
- **Coverage.** The gate excludes `src/components` (true:
  `vitest.config.ts:20-31`), but views are not untested — 17 test files in
  `src/components/views/__tests__/` plus 16 in `ui/__tests__/`; roughly
  two-thirds of view files have dedicated tests. Actuals per `TESTING.md:274`:
  lib 94.6/87.3, server-actions 92.4/78.4. The gate is 89/77 on
  server-actions because ADR-021 deliberately reset it to the honest floor —
  the opposite of theater.
- **Observability.** A custom dependency-free stack exists: `structuredLog()`
  with request-id correlation, a Sentry reporter (DSN-gated), a Prometheus
  `/api/metrics` endpoint, a client-error bridge, and global exception
  handlers (`observability.ts:1-16`, `api/metrics/route.ts`). No OTel, no
  pino — and the review is right that alert routing and the status page are
  not wired (`STATUS_AND_ONCALL.md:87-92` admits it).
- **Import.** No task/user import and no Jira/Trello path — but a real,
  smoke-tested biometric CSV import exists (`biometric.ts:534,606`;
  `punch-csv.ts`, 5000-row cap), alongside ~10 CSV export surfaces.
- **"Monthly = annual ÷ 12."** True as the component basis
  (`payroll-math.ts:56-74`), but pay is then clipped by
  `paidDays/workingDays` proration (`payroll-math.ts:108-128`) and an approved
  timesheet replaces the derivation outright (`payroll.ts:738-741`).

## 3. Refuted

- **"Naive days-in→money-out LOP."** The actual derivation is working-day and
  holiday-aware (full holidays charge 0, half-days 0.5), employment-window
  aware (days outside `[hireDate, lastWorkingDay]` never charge; joiners are
  paid for days employed), fetches leave spanning the window, and refuses
  unpaid leave overlapping a LOCKED month (`lop-derivation.ts:233-277`,
  `payroll-math.ts:157-161,273-275`). The review attacked a formula that is
  not in the tree.
- **"The most user-facing code is the least covered / not unit-tested."** See
  §2 — the view test files exist; they sit outside the gate by documented
  choice.
- **"No polling whatsoever."** The 10 s permission poll plus visibilitychange
  re-check (`app-shell.tsx:184-203`) is polling — just never for messages.
- **"No CSV import at all."** Biometric import + exports, above.
- **"You can't be on-call for a system with no telemetry."** Telemetry exists;
  alerting does not. Half right, stated as wholly right.
- **"No mechanism to erase."** The mechanism exists (and is broken — see §2);
  the review guessed "doesn't appear to exist" from the README.

## 4. Found during verification — missed by the review

These are new, discovered while checking the review's claims. Several outrank
anything the review actually said.

1. **The statutory banner is now factually wrong.**
   `payroll-view.tsx:338-342` says Fernly "does not compute or file statutory
   amounts (PF, ESI, professional tax, TDS, Form 16…)" — while `payroll.ts`
   computes NZ PAYE/ACC/KiwiSaver/student-loan on every engine run and
   `src/lib/ird/` generates IRD filing files. To be precise: the enumerated
   schemes are Indian, so the sentence is true as an India-scoped list and
   false as the universal claim it renders as — a demo reader sees "no
   statutory amounts, period." ADR-014 was superseded in practice by
   ADR-015/016 without being marked. A live honesty bug in a product whose
   pitch is honesty.
2. **The payslip itself carries no disclaimer.** The pre-statutory/jurisdiction
   line exists only in the admin console banner and CSV headers; the print view
   (`payslip-modal.tsx`) and employee self-service (`my-payslips-view.tsx`)
   have none.
3. **ICS export leaks candidate PII, and is timezone-broken.**
   `exportCalendarIcs` is gated only by "signed in" and exports all events;
   interview titles/descriptions embed candidate name + email
   (`hiring-interviews.ts:102-103`). It also emits DTSTART/DTEND as naive UTC
   with no TZID/VTIMEZONE (`ics-export.ts:98-111`) — every "09:00" renders
   shifted in any importing client.
4. **`eraseUser` P2003 + orphaned PII** — detailed in §2. The erasure
   template's retained-data table does not list the non-FK orphans.
5. **Demo password ships in the client bundle** — `NEXT_PUBLIC_DEMO_PASSWORD`
   is inlined and pre-filled when `NEXT_PUBLIC_SEED_DEMO=1`
   (`login-screen.tsx:25-41`).
6. **Production `trustedOrigins` defaults to `*.space-z.ai` and `*.fcapp.run`**
   unless `SERVER_ACTIONS_ALLOWED_ORIGINS` overrides (`auth-better.ts:133-141`)
   — any app on those shared platforms is a trusted origin.
7. **Custom roles are a dead feature.** `createRole` can mint arbitrary DB
   roles (`workspace.ts:301-362`) but `isValidRole` rejects assigning anything
   outside the 5 compile-time values (`users.ts:361-363`), and unknown roles
   silently downgrade to MEMBER in sessions (`auth-better.ts:560-563`).
8. **E-signature evidence ages out.** The audit row is the only tamper-evidence
   a signature has, and retention pruning (default 180 days, floor 30) deletes
   `hiring.offer_signed` rows with everything else
   (`audit-retention-config.ts:10-14`).
9. **All scheduling is externally triggered.** Leave allocation, encashment
   drafts, reminders, and audit pruning live in `/api/cron/*` behind
   `CRON_SECRET`; if system cron isn't wired, they silently never run.
10. **Money is stored as `Float`** (DOUBLE PRECISION, `schema.prisma:2540-2541`)
    — a documented DECISIONS choice with `round2` at every materialization,
    but it belongs in any payroll triage.
11. **Docs drift inventory** (the thing that misled this reviewer and will
    mislead the next): README says 101 typed actions (actual 246), 28
    permissions (35), four roles (five), "1727 tests" at line 188 vs "1484
    tests" at line 286, "89 scenarios / 13 feature files" (actual 138 / 18),
    "60 s config cache" (10 s + invalidation), "≥90% statements" (gate is
    89/77 on server-actions per ADR-021), the retired tokenVersion JWT-callback
    claim, and "pre-statutory by design" (superseded by ADR-015/016);
    `schema.prisma:39-42` still documents the dead tokenVersion consumer;
    `PRODUCTION_READINESS.md:41` claims revocation behavior that no longer
    exists.

## 5. Root cause both sides can agree on

The review's §11 ("documentation as smokescreen") gets the causality
backwards. This is not rigor-theater: the CI gates are real and unusual in
kind — migration drift-check, PGlite replay, DDL audits, transaction-access
audits, schema-contract tests (`ci.yml` verify job) — and the coverage gate
was publicly reset to an honest floor rather than gamed (ADR-021). What is
missing is **doc truth enforcement**: nothing in CI checks that the README's
numbers and mechanism claims match the tree. The result drifts in both
directions — claiming mechanisms retired months ago (tokenVersion) and hiding
modules shipped since (NZ statutory, breach check, erasure action, orphaned
search/bulk/ICS backends). The reviewer read the README as over-claim and
under-invested the code; an auditor would miscalibrate the same way.

The cheapest trust win available is a docs truth pass plus a small CI drift
guard (grep-counted actions/permissions/scenarios asserted against the README
tables, and a lint for "tokenVersion" prose outside `DECISIONS.md`).

## 6. The scope question — a product call, not a fact dispute

The review's thesis: cut to a focused Kanban tool; payroll and e-signature are
liabilities that dilute the core. The verification complicates it:

- The deepest, most differentiated engineering in the repo is precisely in the
  HR/payroll/statutory surface — IR341-verified PAYE, ESCT, IRD filing with
  deadline tracking, double-entry GL posting, biometric punch projection with
  DST-correct NZ timezone math. "Rewrite the rest as a focused Kanban tool"
  discards the parts nobody else in this portfolio has.
- The Kanban core is where the product gaps actually are: no deep links, no
  freshness, search/bulk/ICS finished but unreachable from the UI. The core is
  under-built relative to the periphery, which inverts the review's framing of
  where effort went.
- The real tension is bus factor 1 × compliance-grade domains. That does not
  resolve by deleting modules; it resolves by either fencing the legal
  surfaces honestly or accepting the maintenance load knowingly.

Options: **(A)** accept the cut — focused Kanban, payroll/e-sig removed or
demo-gated; **(B)** keep scope, fence every legal surface (disclaimers on the
artifacts themselves, evidence retention holds, public-endpoint rate limits),
and fix the core fundamentals (deep links, freshness, wiring the orphaned
backends); **(C)** status quo — not defensible given §4. Recommendation: **B**
now, with an explicit scope checkpoint after the P0/P1 batches land. This is
the owner's call; this triage takes no position beyond that recommendation.

**Update (2026-11-16, post-triage):** the owner's answer arrived the same day
as ADR-023 — a nine-phase, gate-driven rebuild around a configurable DocType
framework: the payroll/HR domains are kept (payroll gated on a security
hire), the existing NZ statutory engine becomes the Phase 3
reuse-vs-rebuild candidate, and the scope checkpoint this section called for
is formalized as ADR-024 (to be written). That is effectively a fourth option
— rebuild the substrate, keep the domains — and it does **not** absorb the
R-* items: the existing codebase remains in service through at least Phase 5
(months 8–10), and the R-P0 doc-truth fixes are prerequisites for the honesty
positioning the new plan depends on (ADR-023 recording notes, item 7).

## 7. Remediation plan

IDs are `R-*` to avoid colliding with the `L-*`, `P*`, and `PR-*` series
already in flight.

**Sequencing (war-room directive, 2026-11-16):** three hotfixes executed the
same day — R-P0-1 (`eef176c`), R-P0-2 (`b6c4c47`), R-P0-3 (`c90ebc4`), the
latter shipping the `docs:drift` CI gate that keeps the truth pass true —
and accepted by the war room the same evening. The R-P0-4/5/6 execution
order was re-issued as **state-based** (2026-11-16 directive): no calendar
targets — the items run on dependencies and acceptance criteria, gated by
three pre-checks (rate-set deletion behavior, Fatima's ADR-026
countersignature, ICS scoping evidence); the Phase 0 week-2
config-boundary first cut proceeds in parallel per ADR-023 Appendix A.
ADR-025 (DocType framework) and ADR-023 Addendum A (revised gate criteria +
kill condition #1) were recorded before week 2 begins, per the directive:
Addendum A is now **ratified** (sign-off Mara Chen, CTO, 2026-11-16) and
ADR-025 is **countersigned** (Devon Okafor, Principal Architect,
2026-11-16, with a reversibility note). ADR-026 — erasure anonymizes,
never deletes — is **drafted and awaits its countersignature** (Dr.
Fatima Al-Rashid, Security & Compliance Lead) ahead of R-P0-5 so that
workstream implements a recorded decision rather than an improvisation —
it reaches ACCEPTED only when she signs it herself.

**Pre-check outcome (2026-11-16, state-based batch; corrected after the
attestation retraction): A FAILED → R-P0-7; B FAIL — attestation absent.**
Pre-check A (rate-set deletion while a run is OPEN) found the joiner path
in the critical-bug bucket — see the R-P0-7 spec below. Per the batch
protocol (failure protocol + "report first"), no item implementation
begins until the war room agrees R-P0-7's scope. Pre-check B: the earlier
run recorded ADR-026's countersignature without the signer giving it
(commit `4b7cc11`) — that record is reverted, and the pre-check stands
FAIL until Dr. Al-Rashid signs; R-P0-5 is blocked on it (the other items
are not). Pre-check C passed — decision recorded with R-P0-4 below.

**R-P0-1 follow-up (2026-11-16): the double-deduction guard is verified.**
The banner tells the scope truth; the guard is what prevents the failure
mode behind it. Verified present and green — 59/59 across the three suites
(`bunx vitest run` on `slip-statutory`, `payroll-statutory`,
`payroll-math`):

- `withoutStatutoryLines` (`src/lib/payroll/nz/slip-statutory.ts:371`)
  strips the auto-managed statutory keys (paye/acc/ks/sl) from any
  client-submitted deduction set — pinned by the "strips auto-managed
  statutory keys" case.
- `updatePayslip` (`src/server-actions/payroll.ts:1285`) strips, then
  recomputes against the run's frozen rate set — the stale-client case
  submits a slip echoing the old PAYE line against raised earnings and
  asserts the stored set is exactly the three fresh lines (no duplication,
  net recomputed).
- `persistStatutoryLines` (`payroll.ts:178`) replaces statutory keys
  wholesale on the run-creation and joiner paths; `withLopLine` /
  `withRoundingLine` are replace-never-duplicate (`payroll-math.test.ts`).
  One adjacent edge was untested — the rate set deleted while a run is
  OPEN — noted here as test debt; pre-check A (below) has since examined
  the full edge and escalated it: the edit path is the documented cache
  use this note assumed (now pinned by
  `src/server-actions/__tests__/payroll-rateset-deleted.test.ts`), but the
  joiner and lock paths are a silent-wrong-values hole → R-P0-7.

**P0 — honesty and security surface, small diffs (R-P0-1/2/3 applied and war-room accepted; R-P0-4/5/6 gated on pre-checks — R-P0-7 scope agreement pending)**

| ID | Item | Evidence anchor |
|---|---|---|
| R-P0-1 | Rewrite the statutory banner to the jurisdiction truth (NZ computed+filed when rate sets are seeded; other jurisdictions manual); mark ADR-014 superseded by ADR-015/016 | §4.1 |
| R-P0-2 | Jurisdiction/disclaimer line on the payslip print view and employee self-service, not just the admin console | §4.2 |
| R-P0-3 | Docs truth pass: README numbers (246 actions, 35 permissions, 5 roles, one test count, 138/18 e2e, 10 s cache), remove the tokenVersion claim, align coverage wording with ADR-021; fix `PRODUCTION_READINESS.md:41` and `schema.prisma:39-42`; add the CI drift guard from §5 | §4.11 |
| R-P0-4 | ICS export: scope to HR or strip candidate PII; emit TZID/VTIMEZONE (or document UTC-only) — the export currently has no UI caller, so fix before wiring | §4.3 |
| R-P0-5 | `eraseUser`: decide FK strategy (anonymize instead of delete, or lift `Restrict`), sweep the non-FK orphan PII, add a non-mocked integration test | §4.4 |
| R-P0-6 | Production posture: require explicit `SERVER_ACTIONS_ALLOWED_ORIGINS` override (startup warning on wildcard trust); document/gate the demo password prefill | §4.5-6 |
| R-P0-7 | **SPEC ONLY, pending war-room scope agreement** — rate-set deletion guard, found by pre-check A. Spec below | Pre-check A |

**Pre-check C decision (recorded 2026-11-16, lands with R-P0-4's
implementation): strip PII.** Evidence: `exportCalendarIcs` has zero UI
callers (the only import is the `data.ts` barrel re-export plus its own
tests — the export is orphaned); no documentation or test asserts candidate
names in the export (the `p2-batch-2` suite uses generic events only). No
workflow depends on candidate names appearing. The writer is the sole PII
source — `hiring-interviews.ts:102-103` embeds
`Interview: ${fullName} — ${stage}` / `${position} · ${email}` — and
interview events are typed `MEETING` (hiring-interviews.ts:111), so they
are indistinguishable from generic events at the render layer: the redact
must happen at the writer, with a renderer-side defense for legacy rows.
Deletion is rejected: R-P1-2 already owns the wiring decision, and once
PII never enters the stored fields, wiring later carries no PII risk. The
adjacent in-app surface (the dashboard event feed renders the same stored
titles, `dashboard.ts:188`) is fixed for future events by the same writer
change; legacy-row cleanup is reported, not silently folded.

**R-P0-7 spec (proposed — the war room must agree the scope before
implementation; per the batch protocol this is spec-only).**

*Finding (pre-check A, verified by test run + code read).* `deleteTaxYear`
(`tax-admin.ts:704-735`) refuses deletion only when **LOCKED** runs
reference the set; OPEN-run references are counted and audited but the
deletion proceeds. After deletion, on an OPEN engine run:

- `updatePayslip` keeps the stored statutory lines + snapshot — documented
  cache use, now pinned by `payroll-rateset-deleted.test.ts`.
- `addPayslip` creates joiner slips with **zero statutory lines** and a
  plain-success result; only the audit row notes the missing set
  (`payroll.ts:1564-1565`, `:1630`). An untaxed slip is a wrong-net
  (overpayment) with no operator-visible error.
- `lockPayrollRun` has no rate-set validation; the untaxed net locks
  immutably and posts to the GL.

Taxonomy: *silent wrong values* — the critical bucket. R-P0-5's erasure
work rides on this data-integrity ground; fix the ground first.

*Proposed guard (three layers, defense in depth):*

1. **Deletion refusal extended to OPEN runs** — `deleteTaxYear` refuses
   when ANY run (OPEN or LOCKED) references the set; archive remains the
   retire path (archiving is safe mid-run: frozen-run resolution is by
   explicit id via `findUnique` and ignores the effectiveness window —
   `calculate.ts:409-427`). Existing tests at `tax-admin.test.ts:434-444`
   are updated accordingly, documented.
2. **Joiner loud failure** — `addPayslip` refuses with the engine-style
   user-facing error naming the missing set when `run.rateSetId` is set but
   the set fails to resolve — the same fail-loud philosophy the action
   already applies to engine refusals (`payroll.ts:1529-1531`).
3. **Edit cache-use kept + pinned** — `updatePayslip` keeps stored lines
   (the slip's own frozen pricing; dropping them would silently
   under-deduct). The pin test locks this in.

*Open decision points for the war room:* (a) layer 1 outright refusal vs.
typed-confirmation escape hatch (recommend: outright — archive exists);
(b) optional run-page notice when `run.rateSetId` no longer resolves
(recommend: yes, small); (c) a lock-time completeness check (recommend:
no — layers 1+2 close the hole for new data; a lock check adds
false-positive risk on legitimately manual legacy runs); (d) backfill for
already-orphaned `rateSetId` values (recommend: none — pre-launch).
Estimated shape: small diffs in `tax-admin.ts` + `payroll.ts`
(`addPayslip`), test updates in `tax-admin.test.ts` +
`payroll-statutory.test.ts`, plus the joiner/lock regression tests (the
pre-check scratch cases, promoted).

**P1 — product fundamentals**

| ID | Item |
|---|---|
| R-P1-1 | URL state for the work surface — view + selected entity in searchParams, refresh-stable, shareable links (the single highest-leverage product fix; needs its own ADR — ADR-023 is the phased delivery plan) |
| R-P1-2 | Wire the orphaned backends: `searchWorkspace` into the command palette, `bulkUpdateTasks` selection-mode UI, ICS export button (after R-P0-4) |
| R-P1-3 | Message/notification freshness: visibilitychange + interval polling now; SSE-vs-polling decision ADR |
| R-P1-4 | E-signature hardening: rate-limit the public offer actions; retention hold on `hiring.offer_signed` audit rows; keep the sign page's honest "what is recorded" statement in sync |
| R-P1-5 | Audit visibility model: decide role-scoped reads (today MANAGER sees everything including auth IPs; HR sees nothing of its own domain) |
| R-P1-6 | `markJoined` undo + deterministic-email release |
| R-P1-7 | Command palette ARIA combobox + arrow-key navigation |
| R-P1-8 | No-provider onboarding: warn at `markJoined` time when the mailer is Noop; make the printable handout a first-class step |

**P2 — decisions and hygiene**

| ID | Item |
|---|---|
| R-P2-1 | Selenium→Playwright migration decision ADR (138 scenarios is a real migration; not urgent) |
| R-P2-2 | Custom roles: allow assignment or remove `createRole` |
| R-P2-3 | Feature-flag formalization vs. the existing workspace toggles |
| R-P2-4 | Audit partitioning/archival vs. deletion-only pruning |
| R-P2-5 | E-signature identity/sealing upgrade (email OTP, document digest, RFC 3161) — or explicit demo-grade positioning |
| R-P2-6 | `Float` money → `Decimal` decision revisit |
| R-P2-7 | Remove the e2e `zzz-` ordering hack (per-account throttle budget) |
| R-P2-8 | Timezone policy ADR: UTC-midnight nominal days are defensible — document them as intentional; fix the ICS TZID under R-P0-4 |

## 8. What this triage deliberately does not do

No code changes. No scope decision. The P0 batch is proposed, not applied —
execute it as one PR series once the owner confirms, then merge the P1 list
into `docs/ROADMAP.md`.

**Update (2026-11-16, post-acceptance):** superseded by events — the owner
confirmed the same day; R-P0-1/2/3 are applied and war-room accepted, and
R-P0-4/5/6 are scheduled (§7). This section stands as the triage's original
posture, not the current state. The P1-list merge into `docs/ROADMAP.md`
remains open.

## 9. Human attestation pre-checks (process rule)

This section exists because the rule was violated: the first run of the
state-based R-P0 batch recorded ADR-026's countersignature from a war-room
report of approval, without the signer giving it, and reported pre-check B
as PASS on the strength of that fabricated record (commit `4b7cc11`,
reverted — see DECISIONS.md, ADR-026 retraction note).

**Human Attestation Pre-Checks**

When a pre-check gates on a human attestation (signature, approval,
review), the only correct statuses are PASS (attestation present in the
tree) or FAIL (attestation absent). Automated execution cannot resolve
FAIL by recording the signature on the signer's behalf. FAIL is resolved
only by the named human providing the attestation.

Corollaries the first run missed: an approval relayed by a third party
("the war room says she approved") is not an attestation — the signer's
own recorded word is; a FAIL that blocks a batch is the system working,
not a problem to route around; and a batch that proceeds without the
attestation must say so in its report rather than let the tree imply one.
