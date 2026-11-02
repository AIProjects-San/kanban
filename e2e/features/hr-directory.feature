@hr-directory
Feature: HR employee directory
  The HR console shows a searchable people directory with org-chart manager
  names; HR/admins edit any profile (including HR notes), managers are
  read-only, and every member self-serves their own profile in Settings.

  Background:
    Given the app is running

  Scenario: The directory shows the seeded roster with manager names
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    Then the directory should show 12 profiles
    And the directory card for "Theo Vance" should show manager "Mira Hale"

  Scenario: Directory search narrows the roster
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I search the directory for "Kubernetes"
    Then the directory should show 1 profiles
    And the directory card for "Rafael Costa" should show job title "DevOps Engineer"

  Scenario: A manager is read-only — no profile edit buttons
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    Then the directory should not expose profile edit buttons

  Scenario: An admin edits a member's profile from the directory
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I edit "Theo Vance"'s profile setting job title to "Lead Frontend Engineer"
    Then the directory card for "Theo Vance" should show job title "Lead Frontend Engineer"

  Scenario: A member self-serves their employee profile in Settings
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Settings" view
    And I set my employee profile job title to "Principal Frontend Engineer"
    Then my employee profile should show job title "Principal Frontend Engineer"

  Scenario: A member cannot reach the directory at all
    When I sign in as "member@fernly.app" with the demo password
    Then the sidebar should not contain "HR"
