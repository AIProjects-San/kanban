# Runs LAST on purpose: the app throttles failed sign-ins per email AND per
# source IP, and every scenario in this suite signs in from the same
# localhost IP. This scenario deliberately exhausts both budgets, so if it
# ran anywhere earlier, every later sign-in (correct password included)
# would be throttled and the remaining scenarios would cascade-fail. The
# "zzz" prefix keeps it at the end of Cucumber's alphabetical feature
# order — do not rename it to anything that sorts earlier.
@critical
Feature: Brute-force lockout
  The login flow must resist brute-force attacks.

  Background:
    Given the app is running

  Scenario: 5 failures block the 6th attempt
    When I fail to sign in as "member@fernly.app" 5 times
    And I attempt to sign in as "member@fernly.app" with the correct password
    Then I should still be on the login screen
