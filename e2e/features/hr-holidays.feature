@hr
Feature: Holiday calendar (F1.1)
  Admins and HR maintain the workspace holiday calendar in the HR console's
  Holidays tab (hr:admin only — managers see the console but not the tab).
  Entries remove their date from working-day counting: leave request day
  counts and payroll loss-of-pay denominators respect them. Existing
  requests and runs keep their denormalized counts — the calendar only
  shapes what is created afterwards.

  Scenarios share the seeded database IN FILE ORDER. This file sorts before
  hr-leave.feature, so the exclusion scenario fully undoes its writes before
  the file ends: the far-future holiday is deleted and the member's request
  is cancelled (hr-leave counts PENDING requests exactly, so a leftover
  request would break its assertions).

  Background:
    Given the app is running

  Scenario: Admin browses the seeded NZ public holidays
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Holidays" tab
    And I browse the holiday calendar to 2026
    Then the holiday calendar should show "Labour Day"
    And the holiday calendar should show "Matariki"
    And I browse the holiday calendar to 2027
    Then the holiday calendar should show "Waitangi Day (observed)"

  Scenario: Managers see the HR console but not the Holidays tab
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    Then the HR console should not show a "Holidays" tab

  Scenario: A duplicate holiday date is rejected with a friendly error
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Holidays" tab
    And I browse the holiday calendar to 2026
    And I add a holiday on "2026-12-25" labeled "Duplicate test"
    Then the holiday form should show an error mentioning "2026-12-25 is already a holiday"
    And the holiday calendar should show exactly one entry for "2026-12-25"

  Scenario: A holiday inside a leave range is excluded from the day count
    The admin marks a far-future Monday as a holiday; a member's Mon→Tue
    request over that week then counts 1 working day (the holiday Monday is
    excluded), both in the live preview and in the denormalized request.
    The entry is removed again at the end of the scenario.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Holidays" tab
    And I add a holiday on a far-future Monday labeled "E2E exclusion holiday"
    And I sign out
    And I sign in as "member@fernly.app" with the demo password
    And I open the "Leave" view
    And I fill a "Annual Leave" request from that Monday to the following day
    Then the request form should preview 1 working day with holidays excluded
    And I submit the filled request with reason "E2E holiday exclusion"
    Then a request with reason "E2E holiday exclusion" should appear as Pending in my requests
    And I cancel my request with reason "E2E holiday exclusion"
    And I sign out
    And I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Holidays" tab
    And I browse the holiday calendar to the year of that Monday
    And I delete the holiday labeled "E2E exclusion holiday"

  Scenario: The payslip loss-of-pay line divides by the run's working days
    The seeded OPEN run for November 2026 denormalizes 21 working days
    (no NZ national holidays in November); Yuki's seeded 1 LOP day on a
    6,700 gross is 6,700 × 1 / 21 = 319.05 — not the pre-F1.1 calendar
    division by 30 (223.33).
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Payroll" view
    And I open the payslip for "Yuki Tanaka"
    Then the payslip editor should show a loss-of-pay line of $319.05
