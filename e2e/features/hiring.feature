@critical
Feature: Hiring pipeline (Recruitment R1)
  The hiring board is gated by hiring:view (ADMIN/HR/MANAGER); the manage and
  template-config controls additionally need hiring:manage / hiring:config.
  docs/RECRUITMENT_MODULE_PLAN.md §6-7.

  Background:
    Given the app is running

  Scenario: HR sees the hiring board with the seeded stage columns
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the hiring board should show the stage column "screening"
    And the hiring board should show the stage column "offer"
    And the "Add candidate" button should be visible
    And the "Stages" button should be visible

  Scenario: Manager sees the board but no manage controls
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the hiring board should show the stage column "screening"
    And the "Add candidate" button should not be visible
    And the "Stages" button should not be visible

  Scenario: Member has no access to hiring at all
    When I sign in as "member@fernly.app" with the demo password
    Then the sidebar should not contain "Hiring"

  Scenario: HR advances a candidate's stage from the detail modal
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the candidate card "Sam Whitaker"
    And I advance the current stage
    Then the candidate detail should show the stage "interview_1" as passed

  Scenario: HR schedules an interview on an INTERVIEW stage
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the candidate card "Tomas Eriksen"
    And I open the schedule form for stage "interview_1"
    Then the schedule form should offer the interviewer dropdown

  Scenario: Rejection requires a reason
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the candidate card "Aisha Rahman"
    And I try to reject the candidate
    Then the rejection reason field should be required
