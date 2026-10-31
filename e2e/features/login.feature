Feature: Authentication
  As a workspace member I want to sign in with my email and password,
  and the system must resist brute-force attacks.

  Background:
    Given the app is running

  Scenario: Successful sign-in with valid credentials
    When I sign in as "demo@fernly.app" with password "fernly123"
    Then I should see the dashboard within 15 seconds
    And the sidebar should contain "Dashboard"

  Scenario: Sign-in is rejected with a wrong password
    When I sign in as "demo@fernly.app" with password "wrong-password"
    Then I should still be on the login screen
    And I should not see the dashboard

  Scenario: Sign-in is rejected with an unknown email
    When I sign in as "ghost@fernly.app" with password "whatever-123"
    Then I should still be on the login screen

  Scenario: Empty credentials are rejected
    When I sign in as "" with password ""
    Then I should still be on the login screen

  Scenario: Brute-force lockout — 5 failures block the 6th attempt
    When I fail to sign in as "member@fernly.app" 5 times
    And I sign in as "member@fernly.app" with the correct password
    Then I should still be on the login screen
