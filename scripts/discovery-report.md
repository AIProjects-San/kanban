# Phase 0 Discovery Notes (working notes — NOT part of the user guide)

Date: 2026-11-15. Branch: main @ 7fd8562.

## 1. Application architecture (user-facing shape)

Fernly is NOT a classic multi-page app. Three surfaces:

1. **The workspace SPA at `/`** — one page, 19 sidebar views switched client-side
   (no URL change). This is where nearly all day-to-day work happens.
2. **Six guarded route groups** — 29 separate admin pages (real URLs), each with
   its own layout shell, nav header and "Back to Fernly" link.
3. **One public page** — `/offer/[token]` (offer signing, token = auth).

## 2. Route inventory (31 page.tsx + 13 route.ts)

### Public (2)
| Route | Purpose | Guard |
|---|---|---|
| `/` | Login screen when signed out; workspace shell when signed in | session |
| `/offer/[token]` | Candidate signs/declines an offer | 256-bit token |

### Workspace SPA views (19, inside `/`)
Sidebar groups → views (RBAC gate hides leaves):
- Overview: **Dashboard** (all), **Analytics** (all)
- Work: **Projects** (all), **Tasks** (all), **Bugs** (all)
- People: **Team** (all), **Calendar** (all), **Leave** (all — self-service),
  **My Interviews** (all — own scorecards), **My Payslips** (all — own, locked runs),
  **My Attendance** (all — own + own timesheets)
- HR: **HR Console** (hr:view — 9 tabs: Requests / Types / Holidays / Attendance /
  Balances / Directory / Reviews / Onboarding / Offboarding), **Hiring** (hiring:view),
  **Payroll** (payroll:manage)
- Administration: **Users** (role:manage), **Workspace Config** (role:manage — 9 tabs:
  General / Task Statuses / Project Statuses / Event Types / Tags / Priorities /
  Departments / Roles & Permissions / Notifications), **Audit Log** (audit:view)
- General: **Settings** (all — Profile, Employee Profile, My Reviews, My Onboarding,
  My Documents, My Skill Map, Security, Notifications, Appearance, Time & Locale,
  Privacy), **Help** (all)

### Route-group pages (29)
**(admin) — SUPER_ADMIN only (`statutory:manage`):**
- `/settings/tax/slabs` — Tax years & slabs
- `/settings/tax/rules` — Statutory rules
- `/settings/tax/component-mapping` — Component mapping
- `/employees` — Employee tax profiles (list)
- `/employees/[id]/tax-profile` — one employee's tax profile
- `/employees/[id]/salary-history` — salary timeline + revisions (NOTE: sits under
  the SUPER_ADMIN layout though its action needs payroll:manage → effective
  access SUPER_ADMIN only)
- `/accounting/trial-balance` — trial balance, period close, JE reversal

**(hr-admin) — hr:admin (SUPER_ADMIN/ADMIN/HR):**
- `/admin/employees` — employment-documents index
- `/admin/employees/[id]/transfers` — transfer documents
- `/admin/employees/[id]/promotions` — promotion documents
- `/admin/employees/[id]/loans` — per-employee loans
- `/admin/employees/[id]/loans/[loanId]` — loan detail (schedule/repay)

**(payroll-filing) — payroll:manage (SUPER_ADMIN/ADMIN/HR):**
- `/admin/payroll/filings` — EI filings list
- `/admin/payroll/runs/[id]/filing` — per-run filing panel
- `/admin/payroll/employee-details` — ED filings
- `/admin/payroll/loans` — loans overview
- `/admin/payroll/settings` — filing profile

**(hr-masters) — session (page actions enforce hr:admin):**
- `/admin/settings/hr/departments` — department tree
- `/admin/settings/hr/designations` — designation list + grade link
- `/admin/settings/hr/grades` — grade ladder + salary bands

**(g4-attendance) — session (actions enforce attendance:manage):**
- `/admin/timesheets` — timesheet review queue
- `/admin/employees/[id]/timesheets` — employee timesheets (DOUBLES as the
  employee's own self-service surface: the owner drafts/submits their hours)
- `/admin/shifts` — shift master
- `/admin/shifts/roster` — roster grid
- `/admin/shifts/roster/[date]` — roster day editor

**(g5-biometric) — session (actions enforce attendance:manage):**
- `/admin/settings/biometric/devices` — device registry
- `/admin/settings/biometric/mappings` — device-user mapping
- `/admin/attendance/punches` — punch log + CSV import
- `/admin/attendance/exceptions` — exception queue

### API routes (13) — ALL excluded from the user guide
`/api` (info), `/api/health`, `/api/metrics`, `/api/client-errors`,
`/api/cron/{daily,employee-reminders,prune-audit,leave-encashment,leave-allocation,interview-reminders}`,
`/api/biometric/punch` (device push), `/api/auth/token`, `/api/auth-better/[...all]`.
Reasons: machine endpoints (cron/health/metrics/device/auth internals/error sink).

## 3. Roles & permissions (lib/auth/rbac.ts)

Roles: **Super Admin, Admin, Manager, Member, HR** (34 permissions).
Key user-facing facts:
- SUPER_ADMIN = everything incl. statutory rate tables.
- ADMIN = everything except statutory tables.
- HR = people ops (hr:*, hiring:manage, payroll:manage, attendance) — NO task/project powers.
- MANAGER = projects/tasks + hr:view + hiring:view + hiring:approve (offer approver).
- MEMBER = own tasks/bugs, leave, messages, self-service.
- Self-service surfaces are NOT permission-gated (own data): Leave, My Payslips,
  My Interviews, My Attendance(+ own timesheets).

## 4. Server-action inventory (73 files, 391 exports)

By domain (exports):
- Work core (tasks/projects/bugs/members/messages/events/time/bulk/pagination/
  search/trash/dashboard/analytics): 48
- Users/auth/admin (users/workspace/assignments/audit/audit-retention/
  auth-tokens/auth-guard/password-reset/notifications/notification-templates/
  reminders): 44
- HR (leave, periods, policy sets, comp-off, encashment, directory, attendance,
  holidays, reviews, onboarding, offboarding, employment docs, employee docs,
  skills, masters, employment transitions): 97
- Recruitment (hiring, interviews, offers, formalities, mark-joined): 40
- Payroll (runs/payslips, components, structures, assignments, adjustments,
  benefits, advances, loans, withholding, LWP, arrears, gratuity, retention,
  reports, self-service): 56
- Statutory/filing/accounting (tax-admin, payday-filing, accounting): 38
- Attendance ops (shifts, timesheets, biometric): 33
- Shared/internal helpers (shared, hr-shared, result, ics-export, data-export,
  mentions): 35

### Internal / no-UI-trigger actions (EXCLUDE from user flows)
- auth-guard.ts (getSession/checkPermission/requirePermission*) — plumbing
- shared.ts (14 helpers), hr-shared.ts (16 helpers), result.ts — plumbing
- mentions.ts notifyMentionedUsers — side effect of task/comment writes
- loans.ts settleLoansForRunTx — transaction-internal variant
- search.ts searchWorkspace — NO UI caller (command palette searches commands)
- password-reset.ts requestPasswordReset/validateResetToken/resetPassword —
  exported+guarded but NO UI (no forgot-password link on login screen)
- ics-export.ts exportCalendarIcs — NO UI caller
- payday-filing.ts refreshOverdueFilings — internal sweep
- audit-retention.ts pruneAuditLogs — cron (retention INFO surfaces in
  Workspace Config → General? verify: getAuditRetentionInfo)
- data.ts — barrel re-export (0 own exports)

## 5. Model inventory (106 models)

- User-editable masters/config: User, TeamMember, Project, Task, Bug,
  CalendarEvent, Department, Designation, Grade, EmployeeProfile, LeaveType,
  LeavePolicy(Set), LeavePeriod, HolidayCalendarEntry, SalaryComponent,
  SalaryStructure, LoanType, GratuityRule, TaxYear/TaxSlab, Statutory* rate
  tables, LedgerAccount, AccountingPeriod, Role/Permission, Workspace, 8 *Config
  tables, Skill, NotificationTemplate, PayrollSettings, Shift.
- Workflow/transactional: LeaveRequest/Balance/Ledger/Encashment,
  CompensatoryLeaveRequest, AttendanceRecord, Timesheet(Line), ShiftAssignment,
  Punch, PayrollRun, Payslip, PayAdjustment, SalaryAdvance, Loan(Schedule/
  Repayment), BenefitElection/Accrual, SalaryWithholding, Candidate(Stage/
  Document), EmployeeDocument, BackgroundCheck, OfferRecord/Template,
  EmployeeTransfer/Promotion, PerformanceReview, OnboardingChecklist/Task,
  ExitInterview, FullAndFinalStatement, JournalEntry(Line), PaydayFiling(Line),
  EmployeeDetailsFiling, PaydayAmendmentFiling, EmployeeTaxProfile,
  SalaryStructureAssignment, BiometricDevice/DeviceUserMapping.
- Audit/history/system: AuditLog, EmployeePropertyHistory, MailOutbox,
  Notification, Reminder, Message(MessageRead), TimeEntry, Session, Account,
  Verification, UserSettings, PasswordResetToken, ProjectAssignment.

## 6. Cross-reference (view/page → action module) — see
scripts/discover-view-actions.py output; highlights:
- Settings (self) → users, data-export, hr-directory, hr-reviews,
  hr-onboarding, hr-employee-documents, hr-skills, auth-tokens
- HR Console 9 tabs → hr-leave, leave-periods, leave-policy-sets,
  compensatory-leave, leave-encashment, hr-directory, hr-attendance,
  hr-holidays, hr-reviews, hr-onboarding, hr-offboarding, employment
- Payroll console → payroll, payroll-adjustments, payroll-reports, loans,
  payday-filing, hr-directory + modals: payroll-structures, payroll-components,
  salary-assignments, payroll-benefits, salary-advances, payroll-withholding,
  payroll-lwp, payroll-arrears, payroll-gratuity, payroll-retention
- Hiring board → hiring, hiring-interviews, hiring-offers, hiring-formalities
  (candidate-detail modal), hiring-onboarding (markJoined)
- Loans UI surfaces: Payroll console + /admin/payroll/loans + /admin/employees/[id]/loans

## 7. Discovery findings to flag

1. **No self sign-up.** Accounts are created by admins (Users view) or via
   markJoined (candidate → employee). Login screen is email+password only.
2. **No forgot-password UI.** Reset actions exist server-side but are not
   reachable from the UI. (Exclude; note in guide's excluded list.)
3. **Salary history page is effectively SUPER_ADMIN-only** (route group layout)
   even though its data action requires payroll:manage — document as-is.
4. **Employee timesheets page doubles as self-service** (owner can open their
   own page and draft/submit).
5. **Loans have two admin surfaces** (per-employee under /admin/employees/[id]/,
   overview under /admin/payroll/loans) plus the Payroll console link.
6. e2e feature files (18) confirm the flow inventory: tasks, rbac, payroll,
   my-payslips, my-interviews, messaging, login(+lockout), hr-* (reviews,
   onboarding, offboarding, leave, holidays, directory, attendance,
   qa-hardening), hiring, a11y.
