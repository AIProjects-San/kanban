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

  # F2.10 (R11/D-20) — the four-eyes approval step: a MANAGER (distinct
  # from the HR composer) must approve the DRAFT before HR can send it.
  Scenario: A manager approves the draft offer before it can be sent (F2.10)
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the offer approvals panel should be visible
    When I approve the draft offer
    Then the offer approvals panel should show no drafts awaiting approval

  Scenario: HR sends the approved offer and the candidate signs on the public page (R6)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the "Selected" pool
    And I open the candidate card "Priyanka Menon"
    And I open the offer builder
    And I send the approved offer
    Then the signing link should be displayed
    When the candidate opens the signing link
    And the candidate signs with their full legal name
    Then the public offer page should show the signed confirmation
    And the signed page should offer the printable appointment letter (F2.10)

  # F2.10 (F-R9/E5) — the joining gate: markJoined refuses while a mandatory
  # document is un-VERIFIED or a background check is non-terminal.
  Scenario: The joining gate refuses while formalities are outstanding (F2.10)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the "Selected" pool
    And I open the candidate card "Priyanka Menon"
    And I mark the candidate as joined
    Then a toast should mention "Joining blocked"
    And the joining gate status should list the outstanding blockers

  Scenario: HR completes the formalities and the gate lets the candidate join (F2.10)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the "Selected" pool
    And I open the candidate card "Priyanka Menon"
    And I verify the "bank_details" document
    And I receive the "right_to_work" document
    And I verify the "right_to_work" document
    And I clear the background check
    Then the joining gate status should show the gate satisfied
    When I mark the candidate as joined
    Then the candidate detail should show the hired summary
    And the hired summary should confirm the salary structure was copied (F2.10)

  # F2.10 (F-R10) — scheduling an interview emails the candidate the invite
  # through the reserved INTERVIEW_INVITE outbox kind.
  Scenario: Scheduling an interview emails the candidate an invite (F2.10)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the candidate card "Nadia Petrova"
    And I open the schedule form for stage "interview_2"
    And I submit the interview schedule form
    Then the email outbox should show a recorded email to "nadia.petrova@example.com"

  Scenario: The recruitment funnel panel shows stage + offer analytics (R8)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the funnel panel should show stage metrics
    And the funnel panel should show the offer accept rate

  # P0-6 (D-05/D-18, persona-audit) — mail delivery truth + first-run guidance.
  # Nadia is untouched by every other scenario, so this is self-contained:
  # first reject+email lands in the outbox, then the same-day repeat is
  # BLOCKED (server-side guard) with the actionable error toast.
  Scenario: A duplicate rejection email on the same day is blocked (D-18)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    And I open the candidate card "Nadia Petrova"
    And I try to reject the candidate
    And I fill the rejection reason with "Loop feedback below bar"
    And I toggle the rejection email on
    And I confirm the rejection
    Then a toast should mention "NOT delivered"
    And the email outbox should show a recorded email to "nadia.petrova@example.com"
    When I close the candidate detail modal
    And I open the "Rejected" pool
    And I open the candidate card "Nadia Petrova"
    And I reactivate the candidate
    And I try to reject the candidate
    And I fill the rejection reason with "Second attempt"
    And I toggle the rejection email on
    And I confirm the rejection
    Then a toast should mention "already sent"

  Scenario: HR sees the mail-config warning while no provider is configured (P0-6)
    When I sign in as "remy@fernly.app" with the demo password
    And I open the "Hiring" view
    Then the mail config warning should be visible

  # --- P26 (PL-03/RJ-B18): the interview reminder engine -------------------

  Scenario: The interview reminder switches and template card render in Settings
    The engine's knobs live in Settings → General (the day-of in-app nudge +
    the opt-in email rail), and its event joins the notification template
    registry — so the Notifications tab grows its card automatically.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "Settings" view
    Then the interview reminder toggles should render
    And I open the notification templates settings tab
    And the INTERVIEW_TODAY notification template card should render
