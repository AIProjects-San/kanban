@critical
Feature: Payslip self-service (persona-audit P0-1 / D-02)
  Every signed-in employee sees their OWN payslips — from LOCKED runs only
  ("published" semantics: an OPEN run is still an HR-editable draft and must
  never reach the employee). The full Payroll console stays payroll:manage
  (ADMIN+HR); self-service never exposes another user's slip.
  docs/Fernly_Persona_Acceptance_Assessment.md — backlog item "Employee
  payslip self-service (D-02)".

  Background:
    Given the app is running

  Scenario: A member sees their finalized payslips and opens one read-only
    When I sign in as "yuki@fernly.app" with the demo password
    Then the sidebar should contain "My Payslips"
    And the sidebar should not contain "Payroll"
    And I open the "My Payslips" view
    Then my payslip list should show at least 1 finalized payslip
    When I open my latest payslip
    Then my payslip viewer should be read-only with a print button

  Scenario: Open-run drafts never appear in self-service
    When I sign in as "yuki@fernly.app" with the demo password
    And I open the "My Payslips" view
    Then my payslip list should not include the current open month

  Scenario: The dashboard links to My Payslips when a payslip exists
    When I sign in as "yuki@fernly.app" with the demo password
    Then the dashboard should show the latest payslip card
