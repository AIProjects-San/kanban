# Fernly E2E — Selenium + Cucumber (Node.js)

Browser end-to-end tests driven by [Cucumber.js](https://cucumber.io/docs/installation/javascript/)
and [Selenium WebDriver](https://www.selenium.dev/documentation/webdriver/).

## Running the whole suite / a subset

CI runs everything through `bun run test:e2e` (`cucumber.cjs` globs
`e2e/features/**/*.feature`). To run ONE feature locally without editing
the config — beware that CLI arguments MERGE with the config paths, so a
bare `cucumber-js e2e/features/x.feature` silently runs the whole suite:

```bash
E2E_ONLY=e2e/features/hiring.feature bunx cucumber-js -c e2e/cucumber.only.cjs
```

`e2e/cucumber.only.cjs` is the default profile with `paths` sourced from
`E2E_ONLY`. Local runs need Chrome + a matching chromedriver (Selenium
Manager resolves both; set `CHROME_BIN` for a non-standard binary), a
seeded database (`SEED_DEMO=1 bun run db:seed`) and the dev server up.
Run a subset BEFORE the lockout feature has charged the sign-in throttle
when chaining runs — the 15-minute window is per email+IP and a second
suite launched inside it will 429-cluster exactly like a real
brute-force lockout would.

## Failure artifacts

Failed scenarios write a screenshot + a state file (URL, main h1, live toasts,
and the captured browser console — SEVERE errors, chunk-fetch failures,
Fast Refresh rebuilds) into `e2e/artifacts/`. CI uploads the folder with every
run; the console capture exists precisely so a blank main area or a stuck
login never has to be diagnosed from a timeout alone.

## What is covered

**138 scenarios across 18 feature files:**

| Feature file | Scenarios |
| ------------ | --------------------------------------------------------------------------------- |
| `login.feature` (5) | valid sign-in, wrong password, unknown email, empty fields, sign-out clears the session |
| `rbac.feature` (5) | admin vs member sidebar, project-create gating, member workspace scoping |
| `tasks.feature` (3) | create task, drag to another Kanban column, delete task |
| `messaging.feature` (3) | send message, recipient inbox visibility, third-party inbox isolation |
| `a11y.feature` (9) | axe WCAG smoke on all primary surfaces (login, dashboard, tasks, team, bugs, calendar, analytics, audit log, settings) |
| `hr-attendance.feature` (5) | F1.3 attendance records: HR opens the Attendance tab and sees the roster grid; managers see the HR console but not the Attendance tab; HR marks a far-future day and a duplicate record is rejected with a friendly error, then the record is deleted; approved leave derives ON_LEAVE in the member's My Attendance view and cancelling the request removes it again |
| `hr-holidays.feature` (5) | holiday calendar: entries list + half-day flag, HR adds an entry, duplicate dates rejected, the calendar view marks holidays |
| `hr-leave.feature` (18) | balances + own requests, request form with policy enforcement (weekend block, balance cap, minimum notice, overlap rejection), cancel, chain approval, MEMBER sidebar must not contain the HR group |
| `hr-directory.feature` (15) | roster + search, manager read-only, admin edits, member self-serves contact fields, member blocked |
| `hr-reviews.feature` (7) | manager's subtree queue, out-of-chain invisible, self-assessment, manager/HR/skip-level completion, employee acknowledgement |
| `hr-onboarding.feature` (9) | seeded checklists + progress, create from template, add task, auto-complete on last tick, hire self-serves, outsider blocked; P35: the derived boarding status chip + required-open counter + role-scoped assignee label + holiday-aware due date, the template editor's assignee-axis chips, the pinned start-date walk |
| `hr-offboarding.feature` (4) | F2.1 offboarding: exit a leaver through the separation checklist; settling the FnF statement locks payslip editing |
| `hiring.feature` (25) | HR sees board + manage controls, manager view-only, member gated, HR advances a stage, rejection requires a reason; R3: select candidate (offer-prep banner), reject with email lands in the outbox, seeded outbox row visible, manager never sees the outbox, selected-pool chip counts; R4: joining formalities of a selected candidate (checklist + BGV vendor), request a document from the checklist, doc-type editor config-gated; R5: HR builds an offer for a selected candidate (live CTC), offers panel lists records, manager never sees the panel; R6: HR sends the offer + the candidate signs on the public `/offer/<token>` page (four-eyes approval first, printable appointment letter after signing), HR marks the signed candidate joined (hired summary + payroll-ready line); F2.10: the joining gate refuses while formalities are outstanding, then passes once complete; R8: the funnel panel shows stage metrics + the offer accept rate; P0-6: a duplicate rejection email on the same day is blocked, HR sees the mail-config warning while no provider is configured |
| `payroll.feature` (7) | HR sees the seeded runs (LOCKED + OPEN) and structures; payslip list shows the LOP hint; payslip editor shows the live net; HR edits loss-of-pay days and saves; HR creates next month's run and locks it (the lock transaction also flips encashments PAID and writes benefit accruals); managers never see the Payroll leaf |
| `my-payslips.feature` (3) | payslip self-service (persona-audit P0-1/D-02): member sees their own finalized payslips and opens one read-only with print; the OPEN current month never appears; the dashboard shows the latest-payslip card |
| `my-interviews.feature` (2) | interviewer self-service (persona-audit P0-5/D-04): member with no assignments sees the empty surface and never the Hiring leaf; HR assigns a member as interviewer and the member fills their own scorecard from My Interviews |
| `hr-qa-hardening.feature` (2) | regression pack from the HR QA audit: approving past the remaining balance is refused; a next-year request is not blocked by this year's balance |
| `zzz-login-lockout.feature` (1) | 5 failures block the 6th attempt (runs last so its lockout state can't pollute other scenarios) |

## Prerequisites

1. **Chrome or Chromium** installed locally (or `SELENIUM_BROWSER=firefox` with Firefox).
2. **The app running** with a seeded database:

   ```bash
   bun run db:seed
   bun run dev          # http://localhost:3000
   ```

3. If the app runs elsewhere, point the suite at it:

   ```bash
   BASE_URL=https://your-deployment.example.com bun run test:e2e
   ```

## Running

```bash
bun run test:e2e              # headless Chrome against BASE_URL (default localhost:3000)
SELENIUM_HEADLESS=0 bun run test:e2e   # watch the browser
```

Failed scenarios automatically capture a screenshot into the Cucumber report.

## Environment variables

| Variable            | Default                  | Purpose                          |
| ------------------- | ------------------------ | -------------------------------- |
| `BASE_URL`          | `http://localhost:3000`  | Target app instance              |
| `SELENIUM_BROWSER`  | `chrome`                 | `chrome` \| `firefox` \| `edge`  |
| `SELENIUM_HEADLESS` | `1`                      | `0` opens a visible browser      |

## Design notes & honest limitations

- **Sequential by default** (`parallel: 0`): the suite shares one database, so
  parallel scenarios would race on shared state (e.g. the brute-force lockout
  test pollutes the login rate limiter for its email/IP window). Give each
  run a fresh seed if a scenario unexpectedly fails.
- The **lockout scenario depends on the in-memory limiter** — restarting the
  server between runs resets the counters.
- Step definitions prefer **roles, labels and keyboard shortcuts** over CSS
  classes, but the app's modal buttons still rely on text matching; if a
  button label changes, update the corresponding XPath.
- **The suite is NOT part of the default `vitest` run** — it needs a real
  browser. Locally that means Chrome/Chromium (or `SELENIUM_BROWSER=firefox`);
  on CI, GitHub's `ubuntu-latest` runners ship Google Chrome and the dedicated
  `e2e` job (`.github/workflows/ci.yml`) runs the full suite on every push and
  PR against a seeded ephemeral PostgreSQL 16. The unit/integration suites
  (`src/**/*.test.ts`) cover the same authorization logic at the action layer
  and run everywhere.
- **HR scenarios need seeded HR data** (leave types/policies/balances,
  employee profiles, review cycles, onboarding checklists) — all provided by
  `scripts/seed.js`. `scripts/qa-cleanup.cjs` removes leave requests created by
  failed QA-hardening runs (reason prefix `QA `) and restores the balances
  they debited.
