@a11y
Feature: Accessibility smoke scan (axe-core) — PR-39
  Production-readiness round 2, roadmap §6.11: a full WCAG 2.1 AA audit is
  a large effort, but the highest-traffic surfaces must stay free of
  SERIOUS and CRITICAL violations (missing labels, broken landmarks,
  keyboard traps, contrast failures). Each scan runs the real axe-core
  engine in the browser against the WCAG 2.0/2.1 A+AA rule set.

  Scenario: Login page has no serious or critical axe violations
    Given the app is running
    Then the page passes an axe accessibility scan

  Scenario: Admin dashboard has no serious or critical axe violations
    Given the app is running
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Dashboard" view
    Then the page passes an axe accessibility scan

  Scenario: Tasks view has no serious or critical axe violations
    Given the app is running
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Tasks" view
    Then the page passes an axe accessibility scan

  Scenario: Team directory has no serious or critical axe violations
    Given the app is running
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Team" view
    Then the page passes an axe accessibility scan
