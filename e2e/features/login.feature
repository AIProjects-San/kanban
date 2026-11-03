@critical
Feature: Authentication
  As a workspace member I want to sign in with my email and password,
  and the system must resist brute-force attacks.

  The Better Auth stack (the only stack since the PR-49 cleanup —
  docs/AUTH_MIGRATION_PLAN.md) serves /api/auth-better/* with the
  fernly.* cookies.

  Background:
    Given the app is running

  @smoke
Scenario: Successful sign-in with valid credentials
    When I sign in as "demo@fernly.app" with the demo password
    Then I should see the dashboard within 15 seconds
    And the sidebar should contain "Dashboard"
    And the fernly session cookie should be set

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

  Scenario: Sign-out returns to the login screen and clears the session
    When I sign in as "demo@fernly.app" with the demo password
    Then I should see the dashboard within 15 seconds
    When I sign out via the sidebar
    Then I should see the login screen within 10 seconds

  # NOTE: the brute-force lockout scenario used to live here. It moved to
  # zzz-login-lockout.feature so it runs LAST — it exhausts the per-IP login
  # throttle budget, which would cascade-fail every later scenario (see the
  # comment in that file).
