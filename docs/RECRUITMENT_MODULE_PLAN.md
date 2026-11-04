# Recruitment & Joining Formalities Module Plan

Status: ALL SHIPPED — R1–R8 complete (2026-11-04) · Owner: HR module family (docs/HR_MODULE_PLAN.md sibling)
Decisions confirmed with the product owner on 2026-11-04 (see §1.3).

---

## 1. Scope & Research

### 1.1 What we are building

A configurable recruitment pipeline that takes a company from **candidate entry to a
paid employee**: stage-based pipeline (company-configurable), interview scheduling on
the shared calendar with scorecards, selection/rejection with reasons + rejection
emails, background-check and document-collection tracking, an offer builder with
role-based salary structures and benefits, e-signature via a secure token link,
automatic employee creation on joining (deterministic email format), and full
payroll (monthly earnings/deductions editing, lock periods, YTD totals, stored
payslips).

### 1.2 Research summary (selection process & joining formalities)

Sources: AIHR "Selection Process: 7 Steps" (aihr.com/blog/selection-process-practical-guide),
Omnivoo "India Employee Onboarding Checklist: 32-Point 2026 Compliance Guide"
(omnivoo.com/blog/india-employee-onboarding-checklist), Indeed "New Employee
Paperwork Checklist", Bharat Payroll & Mysa CTC-structure guides, structured-
interview scorecard guides (Pin/Indeed/Asana 1–5 scale), e-signature audit-trail
best practices (Blueink/Common Paper/SignNow).

**A. Candidate selection funnel — step, what happens, owner:**

| # | Step | What happens | Default owner |
|---|------|--------------|---------------|
| 1 | Application | Candidate applies to a role | Recruiter/HR manages channels |
| 2 | Screening & pre-selection | Resume + phone screen; pool → 3–10 | HR |
| 3 | Interview 1 (technical) | Role suitability, structured (STAR) | Hiring MANAGER |
| 4 | Interview 2 (HR/culture) | Values, communication, fit | HR |
| 5 | Assessment (optional) | Work sample / tests | HR |
| 6 | References & background check | Verify claims; 3rd-party BGV | HR |
| 7 | Decision | Select or reject **with a reason** | HR + hiring manager |
| 8 | Offer & contract | Offer letter with salary breakdown + benefits; sign | HR |

**B. Joining formalities timeline (post-offer-acceptance):**

- **Pre-day-1** (T-14…T-1): signed-offer filed with date · **BGV initiated on
  acceptance** (not on joining day) · document collection list sent (PAN/Aadhaar/
  ID, bank details + cancelled cheque, education certificates, experience &
  relieving letters, last-3-months payslips, photos, address proof) · appointment
  letter drafted · employee code generated · **email/IT provisioning** (3–5 day
  lead) · manager + buddy assigned · first-week calendar · statutory forms ·
  day-1 logistics.
- **Day-1**: welcome · original-document verification · appointment-letter
  signing · ID badge · IT handover · mandatory trainings.
- **Week-1**: statutory registrations (PF/UAN, ESI, professional tax), tax regime
  + investment declaration, gratuity nominee, insurance enrolment, handbook
  acknowledgement.
- **Month-1**: **first payroll verification** (payslip matches appointment
  letter), probation check-in, statutory numbers communicated.

**C. Salary structure (CTC) & payslip components:**

- CTC: Basic (40–50%) · HRA (~20%; 40–50% of basic) · special/conveyance/medical
  allowances · variable/performance pay · employer PF (12% of basic) · gratuity
  provision (4.81% of basic) · insurance.
- Payslip: earnings (Basic, HRA, conveyance, medical, special, LTA) = gross;
  employee deductions (PF 12%, professional tax, TDS, loss-of-pay, advances);
  **net = gross − employee deductions**; employer contributions listed separately.

**D. Interview scorecards:** structured criteria per stage, 1–5 scale
(1 = does not meet, 3 = meets, 5 = clearly exceeds), strengths/concerns, and a
recommendation (strong hire / hire / no hire). Structured interviews predict ~2×
better than unstructured.

**E. E-signature best practice:** secure tokenized link, expiry, audit trail
(who/when/IP), immutable signed snapshot stored with the record, reminders.

### 1.3 Confirmed product decisions

| Decision | Choice |
|---|---|
| Scope | Full funnel (candidate → payslip), payroll for hired employees |
| Stage ownership | HR-driven; MANAGERs as interviewers (remarks only); ADMIN configures |
| Configurability | Workspace stage-template editor + per-candidate override (skip/add/reorder) |
| Interviews | Calendar-linked (events + reminders + interviewer assignment + scorecards) |
| Offer & sign | Tokenized link + typed e-sign; signed snapshot + timestamp in DB |
| Payslips | Full payroll: per-month earnings/deductions editing, lock once paid, YTD |
| Emails | Auditable Outbox table + view; real send via Resend only when key present |
| Onboarding link | Marking "Joined" auto-creates the User + onboarding checklist |
| Employee email | `<first>.<last>@<domain>`; collision → `<first>.<last><n>@<domain>` (n = 2,3,…) |

### 1.4 Stage types (the vocabulary of the pipeline)

`SCREENING · INTERVIEW · ASSESSMENT · BG_CHECK · DOCUMENTS · OFFER · CUSTOM`

Each template stage carries: key, label, type, default owner role, description,
sort order, active flag. Stage instances (per candidate) snapshot label/type at
instantiation so template edits never rewrite candidate history.

### 1.5 Candidate / stage status vocabularies

- Candidate: `ACTIVE` → `HIRED` | `REJECTED` (with reason + notified flag) |
  `WITHDRAWN` (candidate pulled out).
- Stage instance: `PENDING` → `IN_PROGRESS` → `PASSED` | `FAILED`; plus `SKIPPED`
  (per-candidate override). Rejection/withdrawal freezes the pipeline.
- Documents (R4): `REQUESTED` → `RECEIVED` → `VERIFIED` | `REJECTED`.
- Background check (R4): `PENDING` | `IN_PROGRESS` | `CLEAR` | `FLAGGED`.
- Offer (R5/R6): `DRAFT` → `SENT` → `SIGNED` | `DECLINED` | `EXPIRED`.
- Payroll (R7): run `OPEN` → `LOCKED`; payslip inherits the run's lock state.

---

## 2. Data model (full-module view; R1 ships the first three tables)

Relation-light like the HR module (plain string FKs, SQLite-compatible, bulk
name lookups) — see docs/HR_MODULE_PLAN.md and the schema comments.

- **HiringStageConfig** — the workspace template (key, label, stageType,
  ownerRole, description, sortOrder, isActive).
- **Candidate** — fullName, email (unique), phone, position, department, source,
  resumeUrl, notes, status, rejectReason, decidedAt, createdById, userId (set on
  hire), joinedAt.
- **CandidateStage** — per-candidate snapshot + state: stageKey, label,
  stageType, ownerUserId, status, scheduledAt, remarks, rating (1–5), sortOrder,
  startedAt, completedAt. Unique (candidateId, stageKey).
- **MailOutbox** (R3) — every outgoing email stored (kind, to, subject, body,
  sentById, sentAt, providerMessageId, status).
- **CandidateDocument** (R4) — doc type (configurable list), status, fileRef,
  verifiedById/verifiedAt, remarks.
- **BackgroundCheck** (R4) — vendor, initiatedAt, status, reportRef, notes.
- **OfferTemplate** (R5) — per-role salary structure template (components JSON,
  benefits JSON, letter template).
- **OfferRecord** (R5/R6) — candidateId, template snapshot, negotiated numbers
  (components JSON), status, token, tokenExpiresAt, signedAt, signedName,
  signedIp, snapshot JSON.
- **SalaryStructure** (R7) — per-employee structure copied from the offer,
  effectiveFrom, editable components (earnings + employer contributions).
- **PayrollRun** + **Payslip** (R7) — month, status OPEN/LOCKED; per-employee
  earnings/deductions lines (editable while open), net pay, YTD totals, slipNo.
- **Workspace** gains `hiringEmailDomain` (default `fernly.app`) for the
  deterministic employee-email rule (R6).

## 3. RBAC

| Permission | ADMIN | HR | MANAGER | MEMBER | Gates |
|---|---|---|---|---|---|
| `hiring:view` | ✓ | ✓ | ✓ | — | Hiring nav leaf + board read |
| `hiring:manage` | ✓ | ✓ | — | — | Candidate CRUD, advance/decide stages, schedule |
| `hiring:config` | ✓ | ✓ | — | — | Stage-template editor, doc-type list, offer templates |
| `payroll:manage` (R7) | ✓ | ✓ | — | — | Payroll nav leaf, structures, runs, payslips, lock |

Interviewer specifics (R2): an assigned interviewer (any role) may read their own
assigned interview stage and write remarks/rating for it — scoped, not via
`hiring:manage`.

## 4. Navigation & views

- New ViewKey `hiring` → "Hiring" leaf in the HR nav group, permission
  `hiring:view`, shortcut `G I`. The group stays hidden for MEMBER (existing e2e
  contract).
- R1 view = Pipeline board (columns = active template stages, cards =
  candidates; detail modal = stage timeline + advance/skip + remarks).
- Later milestones add tabs/leaves: Offers (R5, inside the builder), Payroll
  leaf `payroll` `G Y` (R7, `payroll:manage`).

## 5. Milestones

Every milestone runs the full cycle: **Plan → review → code → code review →
code fixes → unit tests → manual tests → automation (e2e) tests → final review
→ CI benchmark (lint, typecheck, test:coverage ≥90% on src/lib &
src/server-actions, audit:check, build, bundle budget) → doc update → commit →
push to origin.**

- **R1 — Foundation** *(shipped, 1ead4ff)*: schema (HiringStageConfig/Candidate/CandidateStage) +
  migration; RBAC (3 permissions); stage-template editor; candidate CRUD;
  pipeline board with stage timeline, advance/skip/reject-with-reason basics;
  nav + store wiring; seed data.
- **R2 — Interviews** *(shipped)*: schedule an interview on an INTERVIEW stage → Calendar
  event + reminder + interviewer assignment + conflict check; scorecard
  (1–5 + strengths/concerns + recommendation) per interviewer; interviewer
  self-service ("my interviews" list for MANAGERs).
- **R3 — Decisions & email** *(shipped)*: select (→ offer prep pointer) / reject with
  reason; rejection email with custom remarks via MailOutbox + Resend (send only
  when RESEND_API_KEY set); Outbox viewer (hiring:manage); audit trail.
  Content rule: the internal rejectReason is audit-only — the email carries
  the HR-approved personal note. Every send is recorded (SENT / SKIPPED /
  FAILED); a provider outage never fails the decision itself.
- **R4 — Background check & documents** *(shipped)*: configurable document-type list;
  per-candidate document checklist (request/receive/verify); BGV record
  (initiate on offer acceptance per research, status, vendor, notes); joining-
  formalities checklist surfaced on the candidate (pre-day-1 items).
- **R5 — Offer builder** *(shipped)*: OfferTemplate per role (earnings components from CTC
  research + benefits + letter text), editable (hiring:config); generate offer
  from template → candidate-specific editable numbers; totals + net preview;
  store OfferRecord.
- **R6 — E-sign + auto employee creation** *(shipped)*: tokenized offer link (expiry,
  single-use) with public route; typed signature → immutable snapshot
  (components + terms + signedName + timestamp + IP); mark Joined → auto-create
  User (`<first>.<last>@domain`, collision `<first>.<last><n>`) + EmployeeProfile
  + onboarding checklist (existing module); welcome email queued to outbox.
- **R7 — Payroll (full)** *(shipped)*: SalaryStructure per employee (from offer, editable);
  monthly PayrollRun (OPEN → LOCKED) with per-employee Payslip lines (earnings +
  deductions editable while open; pro-rated LOP); lock period once PAID; YTD
  totals; payslip stored with number + print-friendly download view.
- **R8 — Polish & hardening** *(shipped)*: funnel analytics (candidates per stage,
  time-in-stage, offer-accept rate) on the Hiring board (hiring:view);
  the full 32-permission matrix pinned by unit tests; docs finalized
  (README, ARCHITECTURE, TESTING); e2e hardening; bundle budget re-check.

## 6. Manual test cases — R1 (executed on the sandbox preview)

| # | Case | Steps | Expected |
|---|---|---|---|
| M1 | Board renders (HR) | Sign in as `remy@fernly.app` (HR) → Hiring | Columns for all seeded active stages; candidate cards in correct columns; counts per column |
| M2 | Gating (MEMBER) | Sign in as `member@fernly.app` | No "Hiring" nav item; `G I` does nothing; direct board inaccessible |
| M3 | MANAGER read-only-ish | Sign in as `manager@fernly.app` → Hiring | Board visible; "Add candidate"/advance controls hidden (no hiring:manage) |
| M4 | Add candidate | HR → Add candidate → fill form | Card appears in first column; stage timeline = template; audit entry created |
| M5 | Advance stage | Open candidate → advance current stage | Stage PASSED with timestamp; next stage IN_PROGRESS; card moves column |
| M6 | Skip stage | Skip an upcoming stage | Stage marked SKIPPED; remaining order intact |
| M7 | Reject with reason | Reject candidate, empty reason | Blocked; with reason → card leaves board (status chip filter shows it) |
| M8 | Template edit | Stages editor → rename + reorder + add custom stage | Existing candidates unchanged (snapshot); new candidate gets new template |
| M9 | Template config gating | As MANAGER open Hiring | "Stages" editor button hidden (hiring:config absent) |

## 6b. Manual test cases — R3 (executed on the sandbox preview)

| # | Case | Steps | Expected |
|---|---|---|---|
| M9 | Select candidate | HR → open ACTIVE candidate → Select | Status chip SELECTED + "Offer preparation pending" banner; card moves to the Selected pool; audit "selected" |
| M10 | Undo a selection | On a SELECTED candidate → Reactivate | Back to ACTIVE, decidedAt cleared |
| M11 | Reject with email | Reject → reason + toggle "Email the candidate" + personal note | Card leaves board; outbox row appears with subject + recipient |
| M12 | Outbox dry-run | Same as M11 (no RESEND_API_KEY in the sandbox) | Row resolves SKIPPED — nothing silently sent |
| M13 | Outbox audit copy | Click the outbox row | Body expands; internal reason NOT in the body, personal note IS |
| M14 | Outbox gating | Sign in as `manager@fernly.app` → Hiring | No outbox panel (hiring:manage only); board + interviews visible |
| M15 | Selected pool chip | Hiring → "Selected" filter | Priyanka Menon listed with count 1 |

## 6c. Manual test cases — R4 (executed on the sandbox preview)

| # | Case | Steps | Expected |
|---|---|---|---|
| M16 | Doc-type editor | HR → Hiring → "Doc types" | 5 seeded types; add/edit/reorder/delete works; MANAGER has no button |
| M17 | Checklist renders | Open Priyanka (Selected) | Joining formalities panel: ID VERIFIED, Bank RECEIVED, Right to work REQUESTED, Previous employment REJECTED with note |
| M18 | Request a document | Click "Request" on Education Certificates | Row appears with REQUESTED chip; audit hiring.document_requested |
| M19 | Request all mandatory | Click "Request all mandatory" | Every mandatory type without a row becomes REQUESTED |
| M20 | Receive → verify | Mark received (fileRef) → Verify | RECEIVED with fileRef; then VERIFIED + verified-by name |
| M21 | Reject with note | Reject a RECEIVED doc with a note | REJECTED + note shown; "Re-request" offered |
| M22 | BGV lifecycle | Initiate (vendor) → In review → Cleared | Status chip walks INITIATED → IN REVIEW → CLEARED with completedAt |
| M23 | Panel gating | MANAGER opens any candidate | No joining-formalities panel (hiring:manage only) |

## 6d. Manual test cases — R5 (executed on the sandbox preview)

| # | Case | Steps | Expected |
|---|---|---|---|
| M24 | Offer templates | HR → Hiring → "Offers" | 3 seeded bands with CTC preview; add/edit/delete works |
| M25 | Build offer | Open Priyanka (Selected) → Build offer | Draft listed (Designer Band, CTC $70,040); editor opens |
| M26 | Negotiate | In the editor bump Basic to 70,000 | Totals update live: CTC $72,100; Save draft persists |
| M27 | Offers panel | Back on the board | Offers panel lists the record with DRAFT chip + CTC |
| M28 | Gating | MANAGER opens Hiring | No offers panel, no template button, no Build offer |

## 6e. Manual test cases — R6 (executed on the sandbox preview)

| # | Case | Steps | Expected |
|---|---|---|--- |
| M29 | Send offer | Open Priyanka → Build offer → Send | Row flips to SENT; signing link box appears (copy button); "Awaiting signature — link expires …"; an OFFER row lands in the outbox (SKIPPED without RESEND_API_KEY) |
| M30 | Public sign page | Open the signing link in a private window | Letter + component numbers + net/CTC + benefits render; sign form with the name hint; NO login required |
| M31 | Name ceremony | Type a wrong name → Sign | Blocked with "type your full legal name" error; nothing recorded |
| M32 | Sign | Type "Priyanka Menon" → Sign offer | Signed confirmation; record immutable (offers panel + builder show "Signed by Priyanka Menon · <time>") |
| M33 | Decline path | On a fresh SENT offer → Decline | Declined state on the public page; offer row shows DECLINED |
| M34 | Mark joined gate | Open Priyanka (Selected, signed) | "Offer signed — ready to mark joined" banner; Mark joined enabled |
| M35 | Mark joined | Click Mark joined | Toast with the created account email (priyanka.menon@fernly.app); status HIRED + joined date; WELCOME email in the outbox |
| M36 | Account reality | Sign out → log in as priyanka.menon@fernly.app via "Forgot password?" | Account exists (random password was set; reset flow completes); onboarding checklist visible in HR → Onboarding |
| M37 | Collision | Seed a second "Priyanka Menon" through the pipeline | Second account gets priyanka.menon2@fernly.app |

## 6f. Manual test cases — R7 (executed on the sandbox preview)

| # | Case | Steps | Expected |
|---|---|---|---|
| M38 | Payroll nav (HR) | Sign in as remy@fernly.app → `G Y` | Payroll view; November run OPEN + October LOCKED with "locked by Remy"; 3 structures with CTC + monthly gross |
| M39 | Gating | Sign in as manager@fernly.app | No Payroll leaf anywhere (MANAGER keeps HR Console + Hiring only) |
| M40 | Payslip math | Open the November run | Ingrid $9,000; Hana $7,500 (incl. $500 bonus line); Yuki $6,700 − $223.33 LOP = $6,476.67; YTD = Oct + Nov nets |
| M41 | LOP live | Open Yuki's slip → set LOP to 2 days | Deduction updates live to $446.67, net $6,253.33; Save persists "LOP 2d" on the row |
| M42 | Locked read-only | Open the October run → any slip | Inputs disabled; "paid, immutable record" note; Print / save PDF button |
| M43 | New run | Pick next month → Create run | Run appears OPEN with a payslip per active structure (PS-YYYY-MM-00n slip numbers) |
| M44 | Lock | Lock the new run (confirm) | Chip flips LOCKED; payslips become immutable; audit "payroll.run_locked" with the net total |
| M45 | Structure from offer | New structure → pick employee → Copy from signed offer | Components copied from the SIGNED offer; the previous active structure retires to history |

## 6g. Manual test cases — R8 (executed on the sandbox preview)

| # | Case | Steps | Expected |
|---|---|---|---|
| M46 | Funnel panel | HR → Hiring | "Recruitment funnel" panel: pool totals (7 candidates all-time after seed), stage rows "in progress / passed / avg days", offer accept rate |
| M47 | Velocity | Compare a stage's avg days against the stage timelines | avg = mean of (completed − started) for PASSED and (now − started) for IN_PROGRESS; SKIPPED/PENDING excluded |
| M48 | Accept rate | Offers panel vs funnel | Rate = signed ÷ (signed + declined); "—" until the first decided offer |
| M49 | Funnel for MANAGER | Sign in as manager@fernly.app → Hiring | Funnel panel visible (hiring:view) — no salary data involved |

## 7. Automation (e2e, CI-only)

`e2e/features/hiring.feature` (20 scenarios): MEMBER must not see the Hiring
nav item; HR creates a candidate; advances a stage; rejects with reason.
R3 adds: select (offer-prep banner), reject-with-email lands a SKIPPED
outbox row (CI has no RESEND_API_KEY — the dry-run is the contract), the
seeded Elena rejection row renders, MANAGERs never see the outbox panel,
and the Selected chip counts the pool. R4 adds: the joining-formalities
checklist of a selected candidate (seeded VERIFIED chip + BGV vendor),
requesting a document from the checklist, and the config-gated doc-type
editor button. R5 adds: HR builds an offer for a selected candidate
(draft + live CTC), the offers panel lists records, and MANAGERs never
see it. R6 adds (2 scenarios, order matters): HR sends Priyanka's draft
offer and the candidate signs it on the public `/offer/<token>` page
(the link is minted in-browser and consumed in the same scenario), then
HR marks the signed candidate joined and the hired summary renders.
`payroll.feature` (R7, 5 scenarios): HR sees the seeded runs (LOCKED +
OPEN) and structures, opens a payslip with the LOP hint, edits LOP days
and saves, creates next month's run and locks it (retry-tolerant steps —
the run row satisfies the assertion whether the create won or already
existed), and MANAGERs never see the Payroll leaf. R8 adds: the funnel
panel renders stage metrics and the offer accept rate. Follows the
rbac/hr-directory feature patterns (`data-testid` hooks on the board).

## 8. References

- AIHR selection guide — https://www.aihr.com/blog/selection-process-practical-guide
- Omnivoo 32-point India onboarding checklist — https://omnivoo.com/blog/india-employee-onboarding-checklist
- Indeed new-employee paperwork — https://in.indeed.com/hire/c/info/new-employee-paperwork-checklist
- CTC structure — https://bharatpayroll.com/blog/ctc-structure · https://www.mysa.io/blogs/salary-breakup-ctc-structure-format-calculation
- Structured scorecards — https://www.pin.com/blog/interview-scorecards-templates
- E-sign audit trails — https://commonpaper.com/blog/how-to-send-and-sign-employment-contracts-and-offer-letters-online
