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

  Scenario: HR selects a candidate (R3)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the candidate card "Tomas Eriksen"
    And I select the candidate
    Then the candidate detail should show the offer-prep banner

  Scenario: HR rejects with an email and it lands in the outbox (R3)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the candidate card "Aisha Rahman"
    And I try to reject the candidate
    And I fill the rejection reason with "Role filled internally"
    And I toggle the rejection email on
    And I confirm the rejection
    Then the email outbox should show a recorded email to "aisha.rahman@example.com"
    And the outbox entry should be recorded as skipped

  Scenario: The seeded rejection email is visible in the outbox (R3)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the email outbox should show a recorded email to "elena.moreau@example.com"

  Scenario: Managers never see the email outbox (R3)
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the email outbox panel should not be visible

  Scenario: The selected pool filter counts selected candidates (R3)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the selected filter chip should show a count of at least 1

  Scenario: HR sees the joining formalities of a selected candidate (R4)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the "Selected" pool
    And I open the candidate card "Priyanka Menon"
    Then the joining formalities panel should show the document checklist
    And the document "id_proof" should show status "VERIFIED"
    And the background check section should list the vendor "VerifyRight"

  Scenario: HR requests a document from the checklist (R4)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the "Selected" pool
    And I open the candidate card "Priyanka Menon"
    And I request the "education_certificates" document
    Then the document "education_certificates" should show status "REQUESTED"

  Scenario: The document-type editor is config-gated (R4)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the "Doc types" button should be visible
    When I sign out and back in as "manager@fernly.app"
    And I open the "Hiring" view
    Then the "Doc types" button should not be visible

  Scenario: HR builds an offer for a selected candidate (R5)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the "Selected" pool
    And I open the candidate card "Priyanka Menon"
    And I open the offer builder
    Then the offer builder should list a draft offer with the live CTC total

  Scenario: The offers panel lists offer records (R5)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the offers panel should show "Priyanka Menon" with a DRAFT chip

  Scenario: Managers never see the offers panel (R5)
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the offers panel should not be visible
