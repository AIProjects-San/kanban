@critical
Feature: Authentication
  As a workspace member I want to sign in with my email and password,
  and the system must resist brute-force attacks.

  Background:
    Given the app is running

  @smoke
Scenario: Successful sign-in with valid credentials
    When I sign in as "demo@fernly.app" with the demo password
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

  # NOTE: the brute-force lockout scenario used to live here. It moved to
  # zzz-login-lockout.feature so it runs LAST — it exhausts the per-IP login
  # throttle budget, which would cascade-fail every later scenario (see the
  # comment in that file).
