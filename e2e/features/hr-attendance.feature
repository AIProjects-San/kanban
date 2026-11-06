@hr
Feature: Attendance records (F1.3)
  HR and admins mark daily attendance in the HR console's Attendance tab
  (attendance:manage — a NEW permission; managers see the console but not
  the tab). One record per person per day; approved leave derives ON_LEAVE
  rows automatically, and cancelling that leave removes them again. Members
  never write attendance (decision §9.1) — they read their own month under
  People → My Attendance, which has no marking surface at all.

  Scenarios share the seeded database IN FILE ORDER. This file sorts before
  hr-directory/hr-holidays/hr-leave: every write lands on a far-future
  Monday (~300 days out — beyond every relative range the other feature
  files use) and is fully undone before the scenario ends (the marked
  record is deleted; the derivation request is cancelled, which removes
  its derived rows and restores the balance — only a CANCELLED request
  remains, which no other file counts).

  Background:
    Given the app is running

  Scenario: HR opens the Attendance tab and sees the roster grid
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Attendance" tab
    Then the attendance grid should show a row for "Yuki Tanaka"
    And the attendance grid should show a row for "Theo Vance"

  Scenario: Managers see the HR console but not the Attendance tab
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    Then the HR console should not show a "Attendance" tab

  Scenario: HR marks a day; a duplicate record is rejected; the record can be deleted
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Attendance" tab
    And I mark "Theo Vance" "PRESENT" on a far-future Monday
    Then the attendance grid should show a "PRESENT" cell for "Theo Vance" on that Monday
    And I mark "Theo Vance" "PRESENT" on that same Monday again
    Then the attendance form should show an error mentioning "already has an attendance record for"
    And I delete the attendance record for "Theo Vance" on that Monday
    Then the attendance grid should show no record for "Theo Vance" on that Monday

  Scenario: Approved leave derives ON_LEAVE in My Attendance — and cancelling removes it
    The member requests a far-future Monday→Tuesday annual leave (a DIFFERENT
    Monday than the marking scenario above — 320 vs 300 days out, so the
    PRESENT record there cannot block this range's derivation); the admin
    approves it; the member's own month then shows ON_LEAVE on both days.
    Cancelling the approved request removes the derived rows again (and
    restores the balance) — the scenario leaves no active request behind.
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I request "Annual Leave" from a Monday 320 days out to the following day with reason "E2E attendance derivation"
    Then a request with reason "E2E attendance derivation" should appear as Pending in my requests
    And I sign out
    And I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I approve the request with reason "E2E attendance derivation"
    And I sign out
    And I sign in as "member@fernly.app" with the demo password
    And I open the "My Attendance" view
    And I browse my attendance to the month of the far-future Monday
    Then my attendance calendar should show "ON_LEAVE" on the far-future Monday
    And I open the "Leave" view
    And I cancel my request with reason "E2E attendance derivation"
    Then my request with reason "E2E attendance derivation" should show status "Cancelled"
    And I open the "My Attendance" view
    And I browse my attendance to the month of the far-future Monday
    Then my attendance calendar should show no "ON_LEAVE" on the far-future Monday
