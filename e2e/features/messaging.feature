Feature: Messaging
  Users can message each other, and each inbox only shows its own threads.

  Background:
    Given the app is running

  Scenario: Send a message to another member
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Team" view
    And I send a message with subject "E2E hello" to "member@fernly.app"
    Then I should see a confirmation that the message was sent

  Scenario: The recipient sees the message in their inbox
    When I sign in as "member@fernly.app" with the demo password
    And I open my inbox
    Then my inbox should contain a message with subject "E2E hello"

  Scenario: Other members cannot see that message
    When I sign in as "manager@fernly.app" with the demo password
    And I open my inbox
    Then my inbox should not contain a message with subject "E2E hello"
