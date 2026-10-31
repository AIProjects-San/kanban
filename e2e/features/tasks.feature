Feature: Task board
  Tasks can be created and moved on the Kanban board according to RBAC rules.

  Background:
    Given the app is running
    And I sign in as "demo@fernly.app" with the demo password

  Scenario: Create a task with the minimum required fields
    When I open the "Tasks" view
    And I create a task titled "E2E smoke task"
    Then a task named "E2E smoke task" should appear on the board

  Scenario: Drag a task card to another column
    When I open the "Tasks" view
    And I move the task "E2E smoke task" to the "Done" column
    Then the task "E2E smoke task" should be in the "Done" column

  Scenario: Delete the task again
    When I open the "Tasks" view
    And I delete the task "E2E smoke task"
    Then no task named "E2E smoke task" should remain on the board
