@hr-reviews
Feature: HR performance reviews
  The self + manager cycle: an employee writes and submits a self-assessment,
  their manager (chain-scoped) completes the review with a rating, and the
  employee acknowledges the result. A manager only sees their subtree's
  cycles.

  Background:
    Given the app is running

  Scenario: The manager's queue shows their subtree's cycles
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Reviews" tab
    Then the review queue should show a cycle "2026 Mid-year review" for "Lena Okafor" with status "Submitted"
    And the review queue should show a cycle "2026 Q1 check-in" for "Rafael Costa" with status "Reviewed"

  Scenario: A manager outside the chain does not see those cycles
    When I sign in as "priya@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Reviews" tab
    Then the review queue should not show any cycle for "Lena Okafor"

  Scenario: The employee writes and submits their self-assessment
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Settings" view
    And I write the self-assessment for "2026 Mid-year review" saying "Shipped the board overhaul and mentored Diego."
    And I rate myself 4
    And I submit the self-assessment
    Then my review "2026 Mid-year review" should show status "Submitted"
    And the self-assessment write button should be gone

  Scenario: The manager completes the review with a rating
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Reviews" tab
    And I review "2026 Mid-year review" for "Lena Okafor" with comment "Outstanding API work" and rating 5
    Then the review queue should show a cycle "2026 Mid-year review" for "Lena Okafor" with status "Reviewed"

  Scenario: QA-11 — HR (outside the subject's chain) completes a review
    Remy holds the HR role. The plan (§6) scopes reviewers to "the
    subject's manager chain (or ADMIN/HR)" — Amara reports to Mira, so
    Remy is NOT in her chain. The original ADMIN-only short-circuit
    rejected exactly this call; the e2e proves the HR path works.
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Reviews" tab
    And I review "2026 Q3 check-in" for "Amara Diallo" with comment "Deep user insights — sharpen the survey metrics" and rating 4
    Then the review queue should show a cycle "2026 Q3 check-in" for "Amara Diallo" with status "Reviewed"

  Scenario: The employee acknowledges the reviewed result
    When I sign in as "rafael@fernly.app" with the demo password
    And I open the "Settings" view
    And I acknowledge my review "2026 Q1 check-in"
    Then my review "2026 Q1 check-in" should show status "Acknowledged"
