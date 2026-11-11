@critical
Feature: Payroll (Recruitment R7)
  Salary structures, monthly runs and payslips are gated behind
  payroll:manage (ADMIN + HR only) — MANAGERs and MEMBERs never see the
  Payroll leaf or any payslip data. Runs move OPEN → LOCKED (paid).
  docs/RECRUITMENT_MODULE_PLAN.md §5/§7.

  Background:
    Given the app is running

  Scenario: HR sees the seeded runs and salary structures
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    Then the payroll view should show runs for at least 2 months
    And the payroll view should show a LOCKED run and an OPEN run
    And the payroll view should list salary structures

  Scenario: HR sees the payroll analytics panel (P22)
    The four charts and six number cards render read-time off the LOCKED
    runs (the same published-only basis as payslip self-service); the two
    statutory cards state the ADR-014 decline instead of a fake zero.
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    Then the payroll analytics panel should render the six number cards
    And the outgoing salary chart should show paid months
    And the statutory cards should render the ADR-014 note

  Scenario: HR opens a payslip with the seeded LOP deduction
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    Then the payslip list should show the LOP hint for "Yuki Tanaka"
    When I open the payslip for "Yuki Tanaka"
    Then the payslip editor should show the live net total

  Scenario: HR edits a payslip's loss-of-pay days
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    And I open the payslip for "Yuki Tanaka"
    And I set the loss-of-pay days to 2 and save
    Then the payslip list should show the LOP hint for "Yuki Tanaka"

  Scenario: Auto-derived LOP from attendance marks (F1.4)
    HR marks Hana ABSENT on the first working Monday of next month and
    HALF_DAY on the next working day (holiday-aware — a seeded holiday or
    weekend is skipped). Creating next month's run then derives her payslip's
    loss-of-pay as 1.5 days (ABSENT 1 + HALF_DAY 0.5), tagged auto, with the
    LOP deduction line materialized at creation. The marks land on next-month
    dates only this feature ever touches (attendance e2e uses far-future
    dates; leave e2e uses past/near ranges), so they persist safely; the run
    is then locked by the scenario below.
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Attendance" tab
    And I mark "Hana Park" "ABSENT" on the first working Monday of next month
    And I mark "Hana Park" "HALF_DAY" on the next working day
    And I open the "Payroll" view
    And I create a payroll run for next month
    Then the payslip list should show the LOP hint "1.5d" marked "auto" for "Hana Park"
    When I open the payslip for "Hana Park"
    Then the payslip provenance note should say the LOP was auto-derived

  Scenario: Percent modes materialize on payslips (P23)
    Lena's default-package structure carries an 8%-of-gross earning and a
    6%-of-net advance recovery. The run's payslip shows the percent-of-gross
    line resolved annually (÷12) and the percent-of-net line resolved at
    payroll time through the two-pass kernel on the running net; the
    structure list shows the DEFAULT PKG chip (new structures prefill from
    it). No LOP marks or adjustments exist for Lena, so the numbers are
    deterministic: gross 5,940 (5,500 + 440), deductions 356.40 (6% of
    5,940), net 5,583.60.
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    Then the structure list should show the default package chip
    And I create a payroll run for next month
    Then the payslip list should show a deduction hint for "Lena Okafor"

  Scenario: HR creates next month's run and locks it
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    And I create a payroll run for next month
    Then the new run should appear as OPEN
    When I lock the new run
    Then the new run should be locked

  Scenario: Managers never see the Payroll leaf
    When I sign in as "manager@fernly.app" with the demo password
    Then the sidebar should not contain "Payroll"

  # P39 (EM-16 advances half) — salary advances: issue through the modal,
  # the recovery rides the adapter as per-paycheck deductions.

  Scenario: P39 — HR issues a salary advance and sees the seeded one
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    And I open the advances panel
    Then the advances list shows "Diego Morales" with "outstanding"
    And I issue a 600 advance to "Hana Park" over 3 installments from "2027-01"
    Then the advances list shows "Hana Park" with "$600.00 outstanding"
