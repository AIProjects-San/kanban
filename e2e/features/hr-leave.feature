@hr
Feature: HR leave management
  Members request leave and see their balances; the requester's manager (or
  an admin) is the single approver; policy rails (notice, consecutive days,
  balance, overlap) are enforced at submission; approved leave shows on the
  team calendar and blocks logging hours on those days.

  Scenarios share the seeded database IN FILE ORDER — request reasons are
  unique per scenario so every row can be located deterministically, and
  balance assertions account for the approvals made above them.

  Background:
    Given the app is running

  # --- Self-service (read + submit) --------------------------------------

  @hr-a
  Scenario: Member sees their balances and only their own requests
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    Then the leave balance for "Annual Leave" should show 20 days available
    And my requests list should contain a pending "Annual Leave" request
    And my requests list should not show other members' requests

  @hr-a
  Scenario: Member requests leave for a future week
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" from a Monday 21 days out to the following day with reason "E2E fresh request"
    Then a request with reason "E2E fresh request" should appear as Pending in my requests
    And my requests list should contain exactly 2 pending requests

  @hr-a
  Scenario: Weekend-only requests cannot be submitted
    The client-side guard mirrors the server rule — a weekend-only range has
    zero working days, so the form warns and the submit button stays disabled
    (the server-side rejection is covered by the unit suite).
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" covering only the coming weekend
    Then the request form should warn that the range contains no working days
    And no weekend request should appear in my requests

  @hr-a
  Scenario: The form blocks requests beyond the available balance
    Unpaid leave has zero entitlement — the live balance preview turns red
    and submission is disabled before anything reaches the server.
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I fill a "Unpaid Leave" request from a Monday 21 days out to the following Friday
    Then the request form should show 0 days available and disable submission

  @hr-a
  Scenario: The minimum-notice policy is enforced
    Annual leave requires one day of notice — a same-day request passes the
    client guards and is rejected by the server (form stays open, no row).
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" starting today for one day
    Then the rejected request form should still be open with no "Notice test e2e" row created

  @hr-a
  Scenario: Overlapping an existing active request is rejected
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" from a Monday 35 days out to the following day with reason "E2E overlap original"
    And I request "Annual Leave" from the same Monday to the following day with reason "E2E overlap duplicate"
    Then the rejected request form should still be open with no "E2E overlap duplicate" row created
    And a request with reason "E2E overlap original" should appear as Pending in my requests

  # --- Cancellation -------------------------------------------------------

  @hr-a
  Scenario: Member cancels their own pending request
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I cancel my request with reason "E2E fresh request"
    Then my request with reason "E2E fresh request" should show status "Cancelled"

  # --- Approvals -----------------------------------------------------------

  @hr-a
  Scenario: Admin approves a pending request from a direct report
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I approve the request with reason "Family visit"
    Then the request with reason "Family visit" should show status "Approved"

  @hr-b
  Scenario: Manager rejects a pending request with a note
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I reject the request with reason "Conference trip" with note "Release freeze that week"
    Then the request with reason "Conference trip" should show status "Rejected"
    And the decision note "Release freeze that week" should be visible for that request

  @hr-b
  Scenario: A manager only sees their own subtree in the leave queue
    When I sign in as "priya@fernly.app" with the demo password
    And I open the "HR" view
    Then the leave queue should not contain a request from "Lena Okafor"

  # --- Balance invariant ---------------------------------------------------

  @hr-b
  Scenario: Cancelling an approved request restores the balance
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" from a Monday 28 days out to the following Tuesday with reason "Balance restore e2e"
    And I sign out
    And I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I approve the request with reason "Balance restore e2e"
    And I sign out
    And I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    Then the leave balance for "Annual Leave" should show 16 days available
    When I cancel my request with reason "Balance restore e2e"
    Then the leave balance for "Annual Leave" should show 18 days available

  # --- RBAC ----------------------------------------------------------------

  @hr-b
  Scenario: Member does not see the HR console
    When I sign in as "member@fernly.app" with the demo password
    Then the sidebar should not contain "HR"

  @hr-b
  Scenario: Manager sees the HR console
    When I sign in as "manager@fernly.app" with the demo password
    Then the sidebar should contain "HR"

  @hr-b
  Scenario: Every role sees the Leave self-service view
    When I sign in as "member@fernly.app" with the demo password
    Then the sidebar should contain "Leave"

  # --- Integration ----------------------------------------------------------

  @hr-b
  Scenario: Approved leave appears on the team calendar
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Calendar" view
    Then the calendar should show approved leave for "Rafael Costa"

  @hr-b
  Scenario: Logging hours on an approved-leave day is rejected
    When I sign in as "rafael@fernly.app" with the demo password
    And I open the "Tasks" view
    And I open the task "Harden CI pipeline"
    And I log 2 hours on that task for a date 3 days from today
    Then the time log submission should be rejected with an error mentioning approved leave
