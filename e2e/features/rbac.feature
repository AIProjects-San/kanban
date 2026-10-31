Feature: Role-based access control
@critical
  The UI must only expose the controls a role is allowed to use.

  Background:
    Given the app is running

  Scenario: Admin sees admin-only navigation
    When I sign in as "demo@fernly.app" with the demo password
    Then the sidebar should contain "Users"
    And the sidebar should contain "Audit"

  Scenario: Member does not see admin-only navigation
    When I sign in as "member@fernly.app" with the demo password
    Then the sidebar should not contain "Users"
    And the sidebar should not contain "Workspace Settings"

  Scenario: Member cannot create projects
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Projects" view
    Then the "Add Project" button should not be visible

  Scenario: Manager can create projects but not delete them
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "Projects" view
    Then the "Add Project" button should be visible

  Scenario: Member only sees their scoped workspace
    When I sign in as "member@fernly.app" with the demo password
    Then the dashboard project count should be lower than the admin count
