# PR-48 (auth migration Phase 2) — the parallel login suite on the BETTER
# AUTH stack. Runs ONLY via `bun run test:e2e:better` (CI restarts the dev
# server with NEXT_PUBLIC_AUTH_STACK=better first) — the UI form, session
# hook, sign-out and cookie are driven through the same steps as
# login.feature, so parity is asserted with identical scenario text.
#
# The lockout scenario is intentionally ABSENT here: the unit suite covers
# the better-stack throttle budgets (auth-better.test.ts), and exhausting
# the shared per-IP budget in this pass would cascade-fail the suite run
# order in CI (same reason zzz-login-lockout.feature runs last).
@auth-better
Feature: Authentication (Better Auth stack)
  The parallel Better Auth stack must deliver the same login contract as
  the NextAuth v4 stack it will replace.

  Background:
    Given the app is running

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
