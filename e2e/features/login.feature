Feature: Authentication
  As a workspace member I want to sign in with my email and password,
  and the system must resist brute-force attacks.

  Background:
    Given the app is running

  Scenario: Successful sign-in with valid credentials
    When I sign in as "demo@fernly.dev" with password "fernly123"
    Then I should see the dashboard within 15 seconds
    And the sidebar should contain "Dashboard"

  Scenario: Sign-in is rejected with a wrong password
    When I sign in as "demo@fernly.dev" with password "wrong-password"
    Then I should still be on the login screen
    And I should not see the dashboard

  Scenario: Sign-in is rejected with an unknown email
    When I sign in as "ghost@fernly.dev" with password "whatever-123"
    Then I should still be on the login screen

  Scenario: Empty credentials are rejected
    When I sign in as "" with password ""
    Then I should still be on the login screen

  Scenario: Brute-force lockout — 5 failures block the 6th attempt
    When I fail to sign in as "member@fernly.dev" 5 times
    And I sign in as "member@fernly.dev" with the correct password
    Then I should still be on the login screen
