# Recruitment & Joining Formalities Module Plan

Status: R1 ✓ R2 ✓ shipped (R3 next) · Owner: HR module family (docs/HR_MODULE_PLAN.md sibling)
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

Interviewer specifics (R2): an assigned interviewer (any role) may read their own
assigned interview stage and write remarks/rating for it — scoped, not via
`hiring:manage`.

## 4. Navigation & views

- New ViewKey `hiring` → "Hiring" leaf in the HR nav group, permission
  `hiring:view`, shortcut `G I`. The group stays hidden for MEMBER (existing e2e
  contract).
- R1 view = Pipeline board (columns = active template stages, cards =
  candidates; detail modal = stage timeline + advance/skip + remarks).
- Later milestones add tabs/leaves: Offers (R5), Payroll leaf `payroll` (R7).

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
- **R3 — Decisions & email**: select (→ offer prep pointer) / reject with
  reason; rejection email with custom remarks via MailOutbox + Resend (send only
  when RESEND_API_KEY set); Outbox viewer (hiring:manage); audit trail.
- **R4 — Background check & documents**: configurable document-type list;
  per-candidate document checklist (request/receive/verify); BGV record
  (initiate on offer acceptance per research, status, vendor, notes); joining-
  formalities checklist surfaced on the candidate (pre-day-1 items).
- **R5 — Offer builder**: OfferTemplate per role (earnings components from CTC
  research + benefits + letter text), editable (hiring:config); generate offer
  from template → candidate-specific editable numbers; totals + net preview;
  store OfferRecord.
- **R6 — E-sign + auto employee creation**: tokenized offer link (expiry,
  single-use) with public route; typed signature → immutable snapshot
  (components + terms + signedName + timestamp + IP); mark Joined → auto-create
  User (`<first>.<last>@domain`, collision `<first>.<last><n>`) + EmployeeProfile
  + onboarding checklist (existing module); welcome email queued to outbox.
- **R7 — Payroll (full)**: SalaryStructure per employee (from offer, editable);
  monthly PayrollRun (OPEN → LOCKED) with per-employee Payslip lines (earnings +
  deductions editable while open; pro-rated LOP); lock period once PAID; YTD
  totals; payslip stored with number + print-friendly download view.
- **R8 — Polish & hardening**: funnel analytics (candidates per stage,
  time-in-stage, offer-accept rate); permission-matrix tests completed; docs
  finalized (README, ARCHITECTURE, TESTING); e2e hardening; bundle budget
  re-check.

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

## 7. Automation (e2e, CI-only) — R1

`e2e/features/hiring.feature`: MEMBER must not see the Hiring nav item; HR
creates a candidate; advances a stage; rejects with reason. Follows the
rbac/hr-directory feature patterns (`data-testid` hooks on the board).

## 8. References

- AIHR selection guide — https://www.aihr.com/blog/selection-process-practical-guide
- Omnivoo 32-point India onboarding checklist — https://omnivoo.com/blog/india-employee-onboarding-checklist
- Indeed new-employee paperwork — https://in.indeed.com/hire/c/info/new-employee-paperwork-checklist
- CTC structure — https://bharatpayroll.com/blog/ctc-structure · https://www.mysa.io/blogs/salary-breakup-ctc-structure-format-calculation
- Structured scorecards — https://www.pin.com/blog/interview-scorecards-templates
- E-sign audit trails — https://commonpaper.com/blog/how-to-send-and-sign-employment-contracts-and-offer-letters-online
