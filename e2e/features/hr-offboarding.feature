@hr-offboarding
Feature: HR offboarding & full-and-final lite (F2.1)
  The exit arc: a separation checklist reuses the onboarding machinery
  (kind SEPARATION), the exit interview walks PENDING → SCHEDULED →
  COMPLETED with an in-app notification, and the full-and-final statement
  computes LIVE (unprocessed OPEN-run salary + paid-type encashment minus
  advance-leave recovery) until settlement freezes the amounts and locks
  payslip editing.
  docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 F2.1.

  The hire→probation legs of the acceptance chain are pinned by
  hiring.feature and hr-directory.feature (F1.6's §9.3 gate); this feature
  covers the exit→settled half on fresh ground.

  Background:
    Given the app is running

  Scenario: F2.1 — exit → separation checklist → interview → statement → settled
    Rafael (a seeded ACTIVE employee) leaves: the directory records the
    exit with a last working day, the Offboarding tab picks him up, and the
    whole offboarding flow runs to a settled statement.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I exit "Rafael Costa" with last working day "2026-11-20"
    Then the directory card for "Rafael Costa" should show employment status "Exited"
    When I open the "Offboarding" tab
    Then the offboarding card for "Rafael Costa" should show status "Exited"
    And the offboarding card for "Rafael Costa" should show last working day "20 Nov 2026"
    When I start the separation checklist for "Rafael Costa"
    Then the separation checklist for "Rafael Costa" should show 0 of 5 tasks done
    When I record an exit interview for "Rafael Costa"
    And I schedule the exit interview for "Rafael Costa" on "2026-11-12"
    Then the exit interview for "Rafael Costa" should show status "Scheduled"
    When I complete the exit interview for "Rafael Costa" with notes "Moving closer to family"
    Then the exit interview for "Rafael Costa" should show status "Completed"
    When I generate the full-and-final statement for "Rafael Costa"
    Then the statement for "Rafael Costa" should show status "Unsettled"
    And the statement for "Rafael Costa" should list the line "unused"
    When I settle the full-and-final statement for "Rafael Costa"
    Then the statement for "Rafael Costa" should show status "Settled"

# P38 (EM-16/EM-B12) — the extended line space: pending bonus
  # installments + APPROVED-unpaid encashments fold into the LIVE
  # statement as payables.

  Scenario: P38 — Soren's pending retention bonus rides the live statement
    The seeded PENDING retention installment ($400 × 2 periods past the
    locked boundary) appears as a Bonus payable on the LIVE read, while
    the frozen snapshot (generated before it) stays untouched.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Offboarding" tab
    Then the statement for "Soren Lindqvist" should show status "Unsettled"
    And the statement for "Soren Lindqvist" should list the live line "Retention bonus"
    And the statement for "Soren Lindqvist" should list the live line "2 unpaid installment(s)"

Scenario: P39 — Soren's open advance rides the live statement as a receivable
    The seeded OPEN $800 advance (2 installments, none consumed) appears
    as a Salary advance receivable on the LIVE read.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Offboarding" tab
    Then the statement for "Soren Lindqvist" should show status "Unsettled"
    And the statement for "Soren Lindqvist" should list the live line "Salary advance"

  Scenario: F2.1 — the seeded leaver settles and the payslip lock bites
    Soren (the seeded EXITED employee) has an UNSETTLED statement with all
    three line kinds (unprocessed salary, encashment, advance-leave
    recovery). Settling freezes the amounts — and his OPEN-run payslip
    becomes immutable even though the run itself is still OPEN.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Offboarding" tab
    Then the offboarding card for "Soren Lindqvist" should show status "Exited"
    And the exit interview for "Soren Lindqvist" should show status "Completed"
    And the statement for "Soren Lindqvist" should show status "Unsettled"
    And the statement for "Soren Lindqvist" should list the line "Unprocessed salary"
    And the statement for "Soren Lindqvist" should list the line "unused"
    And the statement for "Soren Lindqvist" should list the line "taken in advance"
    When I settle the full-and-final statement for "Soren Lindqvist"
    Then the statement for "Soren Lindqvist" should show status "Settled"
    When I open the "Payroll" view
    And I open the payslip for "Soren Lindqvist"
    And I set the loss-of-pay days to 0 and save
    Then the payslip refusal toast should mention the settled statement


