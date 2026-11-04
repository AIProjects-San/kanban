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
