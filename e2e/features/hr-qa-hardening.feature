@hr-qa
Feature: HR QA hardening
  Adversarial scenarios from the QA audit (docs/QA_FINDINGS_HR.md). Every
  scenario restores the state it changed so the suite stays re-runnable
  against the shared seeded database (reasons are the deterministic keys).

  Background:
    Given the app is running

  # --- QA-1: leave overdraft guard ---------------------------------------

  Scenario: Approving past the remaining balance is refused
    The balance is fully validated at submission only, so two
    non-overlapping requests each pass it on their own. The second
    approval must be refused once the first has consumed the remaining
    days — not blindly debited into a negative "days left".
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" from a Monday 14 days out for 12 working days with reason "QA overdraft near"
    And I request "Annual Leave" from a Monday 42 days out for 12 working days with reason "QA overdraft far"
    And I sign out
    And I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I approve the request with reason "QA overdraft far"
    And I try to approve the request with reason "QA overdraft near"
    Then the approval should fail with an insufficient-balance error
    And the request with reason "QA overdraft near" should show status "Pending"
    And I sign out
    And I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    Then the leave balance for "Annual Leave" should show 6 days available
    When I cancel my request with reason "QA overdraft near"
    And I cancel my request with reason "QA overdraft far"
    Then the leave balance for "Annual Leave" should show 18 days available

  # --- QA-7: cross-year requests vs the current-year balance preview -------

  Scenario: A next-year request is not blocked by this year's remaining balance
    Annual entitlement resets on Jan 1. A range starting next year is
    validated by the server against that year's fresh entitlement, so the
    form must not disable submission using the current year's leftover
    days (it previously showed "12 of 6 available" and blocked the submit).
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" from a Monday 70 days out for 12 working days with reason "QA next-year request"
    Then a request with reason "QA next-year request" should appear as Pending in my requests
    When I cancel my request with reason "QA next-year request"
    Then my request with reason "QA next-year request" should show status "Cancelled"
