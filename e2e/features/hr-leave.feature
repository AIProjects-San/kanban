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
    And I request "Annual Leave" from a Monday 280 days out to the following day with reason "E2E overlap original"
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

  # --- F2.4 — leave policy engine (advance/earned strategies) ------------

  @hr-b
  Scenario: The advance-leave policy surfaces its floor in the request form
    Advance Annual accrues monthly and permits negative balances down to the
    configured floor; the live preview names the allowance so the member
    knows exactly how far they may go.
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I fill an "Advance Annual" request from a Monday 21 days out to the following Tuesday
    Then the request form should show the advance allowance of 5 days

  @hr-b
  Scenario: The earned strategy's accrued balance shows month by month
    Advance Annual grants two days per elapsed month of the year — the
    balance card reflects the accrual, not a flat entitlement.
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    Then the leave balance for "Advance Annual" should show the accrued advance balance

  # --- P24 (PL-01): notification templates --------------------------------

  @hr-e
  Scenario: A customized notification template flows into the leave notifications
    The admin customizes the "leave decided" template in Workspace Config →
    Notifications; the decision notification the member then receives is
    rendered from the customized template, and resetting restores the
    system default without touching the already-delivered notification.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Workspace Config" view
    And I open the notification templates settings tab
    # Retry self-heal: a first attempt that dies after the customize step
    # leaves the LEAVE_DECIDED override behind (cucumber retry rolls back
    # nothing) — resetting here is a no-op on a clean run (the button is
    # disabled without a row) and deletes the leftover on a retry, so the
    # "System default" assertion below can pass either way.
    And I reset the leave decided notification template
    Then the leave decided template shows the system default
    When I customize the leave decided notification to title "SIGNED OFF: {{typeName}}" and message "{{deciderName}} signed off on your {{daysCount}}-day {{typeName}}{{noteClose}}"
    And I sign out
    And I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" from a Monday 21 days out to the following day with reason "Template flow e2e"
    And I sign out
    And I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I approve the request with reason "Template flow e2e"
    And I open the "Workspace Config" view
    And I open the notification templates settings tab
    And I reset the leave decided notification template
    Then the leave decided template shows the system default
    And I sign out
    And I sign in as "member@fernly.app" with the demo password
    And I open the notifications bell
    Then the notification feed should mention "SIGNED OFF: Annual Leave"
    And the notification feed should mention "signed off on your 2-day Annual Leave"

  # --- P25 (PL-02): the engagement reminder engine ------------------------

  @hr-e
  Scenario: The engagement reminder switches and template cards render in Workspace Config
    The engine's knobs live in Workspace Config → General (birthday, anniversary and
    holiday digests + the days-ahead window + the opt-in email rail), and
    its three events join the notification template registry — so the
    Notifications tab grows their cards automatically.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Workspace Config" view
    Then the engagement reminder toggles should render
    And I open the notification templates settings tab
    And the "EMPLOYEE_BIRTHDAY" notification template card should render
    And the "EMPLOYEE_ANNIVERSARY" notification template card should render
    And the "HOLIDAY_UPCOMING" notification template card should render

  # --- P27 (LV-08): the leave period master --------------------------------

  @hr-e
  Scenario: The leave period master manages named allocation windows
    The Types & Policies tab carries the window master: with no rows the
    implicit calendar-year notice renders (the zero-change default); a
    future fiscal window lists with its dates, its ledger bucket and the
    upcoming badge; a same-start-year candidate is refused with the
    kernel's sentence (the bucket key must stay unique); deleting the
    window before it ever takes effect returns the master to the implicit
    default — create-then-delete, zero fixture drift.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Types & Policies" tab
    Then the leave periods empty notice should render
    When I create a leave period "FY 2031/32 (Apr → Mar)" from "2031-04-01" to "2032-03-31"
    Then the leave periods list should show "FY 2031/32 (Apr → Mar)" as "upcoming" in bucket 2031
    When I try to create a rejected leave period "Calendar 2031" from "2031-01-01" to "2031-03-31"
    Then a toast should mention the period refusal "one allocation window per start year"
    When I delete the leave period "FY 2031/32 (Apr → Mar)"
    Then the leave periods empty notice should render

  # --- P28 (LV-02/LV-03): policy sets + bulk assignment ---------------------

  @hr-e @hr-p28
  Scenario: The leave policy set master with the HR bulk assignment tool
    The Types & Policies tab carries the set master: with no rows the
    per-type-policy default notice renders (the zero-change default); a
    set with two type allocations lists with its chips; the bulk-assign
    tool assigns it to one employee for a future calendar window (the doc
    alone — a future window grants on schedule, nothing lands early);
    re-assigning the same employee to the same window is refused with the
    overlap law's sentence; deleting the ungranted assignment (and then
    the set) returns the master to the default — create-then-delete, zero
    fixture drift (no ledger rows are ever written).
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Types & Policies" tab
    Then the policy sets empty notice should render
    When I create a policy set "Standard 2027" with items "Annual Leave=25, Sick Leave=8"
    Then the policy sets list should show "Standard 2027" with "Annual Leave 25d" and "Sick Leave 8d"
    When I bulk-assign the policy set "Standard 2027" to "Yuki Tanaka" for the window 1 year ahead
    Then the policy assignments list should show "Yuki Tanaka" on "Standard 2027" as pending
    When I try to bulk-assign the policy set "Standard 2027" to "Yuki Tanaka" for the window 1 year ahead again
    Then a toast should mention the assignment refusal "already has an assignment"
    When I delete the policy assignment for "Yuki Tanaka"
    Then the policy assignments list should be empty
    When I delete the policy set "Standard 2027"
    Then the policy sets empty notice should render

  # --- P30 (LV-01/LV-11): compensatory + optional leave --------------------

  @hr-e @hr-p30
  Scenario: Comp-off claims earn ledger days; optional holiday applications consume none
    The seeded pending claim (Theo worked a Saturday) approves through the
    HR queue — the comp GRANT row lands on the ledger and the member's
    Comp Off card shows the earned day. The day then spends through the
    normal request path and cancels back (the reversal restores it). An
    optional-holiday application on the next Saturday lands with 0 days —
    nothing deducted, nothing restored — approve-then-cancel, zero
    ledger drift.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    Then the comp-off queue should show a pending "Comp Off" claim from "Theo Vance"
    When I approve the comp-off claim for "Theo Vance"
    And I sign out
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    Then the leave balance for "Comp Off" should show 1 days available
    And my comp-off claims list should show the approved claim
    When I request "Comp Off" from a Monday 14 days out to the same day with reason "E2E comp day spent"
    Then a request with reason "E2E comp day spent" should appear as Pending in my requests
    And I sign out
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I approve the request with reason "E2E comp day spent"
    And I sign out
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    Then the leave balance for "Comp Off" should show 0 days available
    When I cancel my request with reason "E2E comp day spent"
    Then the leave balance for "Comp Off" should show 1 days available
    When I request "Optional Holiday" on the next Saturday with reason "E2E optional day"
    Then the request with reason "E2E optional day" should show 0 day in my requests
    And I sign out
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I approve the request with reason "E2E optional day"
    And I sign out
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    Then the leave balance for "Optional Holiday" should show 0 days available
    When I cancel my request with reason "E2E optional day"
    Then the leave balance for "Optional Holiday" should show 0 days available
