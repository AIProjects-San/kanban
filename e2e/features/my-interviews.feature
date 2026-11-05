@critical
Feature: Interviewer self-service for members (persona-audit P0-5 / D-04)
  A MEMBER assigned as an interviewer can see their OWN assigned interview
  stages and fill their OWN scorecard — without holding hiring:view, so the
  Hiring board (and its candidate PII) stays hidden from plain members.
  docs/Fernly_Persona_Acceptance_Assessment.md — backlog item "Member
  interviewer access (D-04)"; the scheduler's interviewer picker offers the
  whole directory, so the assigned-interviewer path must actually work.

  Background:
    Given the app is running

  Scenario: A member without assignments sees the empty surface, never the board
    When I sign in as "member@fernly.app" with the demo password
    Then the sidebar should contain "My Interviews"
    And the sidebar should not contain "Hiring"
    And I open the "My Interviews" view
    Then my interviews list should show the assignment empty state

  # Self-contained on Tomas Eriksen: every other hiring scenario either only
  # OPENS his schedule form (never submits), uses Sam/Nadia/Priyanka — or
  # SELECTS him (R3 "HR selects a candidate"), which moves him to the
  # Selected pool. "I open the pool containing" resolves whichever pool he
  # is in at run time, so this scenario is independent of the scenario
  # ordering AND of a fresh seed (the P0-6 self-contained pattern).
  Scenario: HR assigns a member as interviewer and the member fills their scorecard
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the pool containing "Tomas Eriksen"
    And I open the candidate card "Tomas Eriksen"
    And I open the schedule form for stage "interview_1"
    And I pick "Theo Vance" as the interviewer in the schedule form
    And I confirm the interview schedule
    And I sign out and back in as "member@fernly.app"
    Then the sidebar should contain "My Interviews"
    And the sidebar should not contain "Hiring"
    And I open the "My Interviews" view
    Then my interviews list should include "Tomas Eriksen"
    When I fill my scorecard for "Tomas Eriksen" with rating 5 and "STRONG_HIRE"
    Then my scorecard for "Tomas Eriksen" should show as saved
