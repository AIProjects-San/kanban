@hr-directory
Feature: HR employee directory
  The HR console shows a searchable people directory with org-chart manager
  names; HR/admins edit any profile (including HR notes), managers are
  read-only, and every member self-serves their own profile in Settings.

  Background:
    Given the app is running

  Scenario: The directory shows the seeded roster with manager names
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    Then the directory should show at least 13 profiles
    And the directory card for "Theo Vance" should show manager "Mira Hale"

  Scenario: Directory search narrows the roster
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I search the directory for "Kubernetes"
    Then the directory should show 1 profiles
    And the directory card for "Rafael Costa" should show job title "DevOps Engineer"

  Scenario: A manager is read-only — no profile edit buttons
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    Then the directory should not expose profile edit buttons

  Scenario: An admin edits a member's profile from the directory
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I edit "Theo Vance"'s profile setting job title to "Lead Frontend Engineer"
    Then the directory card for "Theo Vance" should show job title "Lead Frontend Engineer"

  Scenario: A member self-serves their contact fields — job data stays HR-owned
    The plan (docs/HR_MODULE_PLAN.md §5) scopes self-service to CONTACT
    fields; jobTitle/department/hireDate are HR-owned. The settings card
    shows them read-only, and saving contact fields must never touch them.
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Settings" view
    Then my employee profile should show job data as read-only
    When I set my employee profile phone to "+64 21 555 0999"
    And I reload and reopen the Settings view
    Then my employee profile should show phone "+64 21 555 0999"
    And my employee profile should show job data as read-only

  Scenario: A member cannot reach the directory at all
    When I sign in as "member@fernly.app" with the demo password
    Then the sidebar should not contain "HR"

  # F1.6 — employment lifecycle (docs/Fernly_HR_Payroll_Enhancement_Plan.md
  # §7.1, decision §9.3). The seed marks Diego (the in-progress new hire) as
  # PROBATION with a SUBMITTED probation review, so the whole hard-gate
  # story is demonstrable: refused while the review is outstanding, unlocked
  # once the manager completes it.
  Scenario: F1.6 — the directory shows each employee's employment status
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    Then the directory card for "Diego Morales" should show employment status "Probation"
    And the directory card for "Theo Vance" should show employment status "Active"

  Scenario: F1.6 — the probation hard gate refuses confirmation while the review is outstanding
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I change "Diego Morales" employment status to "Active"
    Then a toast should mention "Probation review outstanding"
    And the directory card for "Diego Morales" should show employment status "Probation"

  Scenario: F1.6 — a completed probation review unlocks the confirmation
    Diego reports straight to Mira (demo@, ADMIN) — the queue shows every
    cycle for an admin, so the same session can complete the review and
    then confirm him.
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Reviews" tab
    And I review "2026 Probation review — Diego" for "Diego Morales" with comment "Strong first six weeks — confirmed." and rating 4
    And I open the "Directory" tab
    And I change "Diego Morales" employment status to "Active"
    Then the directory card for "Diego Morales" should show employment status "Active"

  # P34 (EM-03) — the employee grouping axes: the roster card carries the
  # grade / employment-type / branch facts (seeded: Theo L4 full-time at the
  # Auckland HQ branch; Diego the probation new-hire is the INTERN), and the
  # org-slicing filter chips narrow the roster by each axis (the count line
  # always tells the truth; unclassified members surface only under All).
  Scenario: P34 — the directory card shows each member's grouping axes
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    Then the directory card for "Theo Vance" should show grade "L4"
    And the directory card for "Theo Vance" should show employment type "Full-time"
    And the directory card for "Theo Vance" should show branch "Auckland HQ"
    And the directory card for "Diego Morales" should show employment type "Intern"

  Scenario: P34 — the org-slicing filter chips narrow the roster
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And the directory should show at least 13 profiles
    When I filter the directory by employment type to "Intern"
    Then the directory should show 1 profiles
    And the directory card for "Diego Morales" should show employment type "Intern"
    When I filter the directory by employment type to "Full-time"
    Then the directory should show at least 10 profiles
    When I filter the directory by grade to "L4"
    Then the directory should show 3 profiles
    And the directory card for "Theo Vance" should show grade "L4"

  # P36 (EM-21) — employee identification documents: the scope-gated master
  # and the lifecycle (request → submit → verify), plus the member
  # self-service submission surface.

  Scenario: HR requests an identification document and the member submits it
    Diego is the profile-with-login showcase (the seeded passport REQUESTED
    rides the same panel).
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I open the identification documents panel for "Diego Morales"
    And I request the "Visa / Work Permit" identification document
    Then the identification panel shows "Visa / Work Permit" as "Requested"
    And I sign out and back in as "diego@fernly.app"
    And I open the "Settings" view
    And I submit my identification document "Visa / Work Permit" with reference "visa_diego.pdf"
    Then my identification documents show "Visa / Work Permit" as "Received"

  Scenario: HR verifies the submitted identification document
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I open the identification documents panel for "Diego Morales"
    And I verify the identification document "Visa / Work Permit"
    Then the identification panel shows "Visa / Work Permit" as "Verified"

  Scenario: Hana's seeded identification document shows verified
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I open the identification documents panel for "Hana Park"
    Then the identification panel shows "Tax Number (IRD)" as "Verified"

  # P37 (EM-19, PF-07, EM-18) — the skill master + the employee skill maps:
  # the rated record on the profile card + the map panel + the member's
  # read-only view.

  Scenario: The directory card shows the top-rated skills
    When I sign in as "manager@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    Then the directory card for "Theo Vance" should show top skills including "React 5/5"
    And the directory card for "Theo Vance" should show top skills including "Accessibility 5/5"

  Scenario: HR opens the skill map and rates a skill
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Directory" tab
    And I open the skill map panel for "Diego Morales"
    Then the skill map summary shows no rated skills yet
    And I rate the "Kubernetes" skill 4 with note "cluster rollout owner"
    Then the skill map shows "Kubernetes" rated "4/5 · Advanced"
    And the skill map summary shows 1 skill

  Scenario: The member sees their own rated skill map read-only
    When I sign in as "diego@fernly.app" with the demo password
    And I open the "Settings" view
    Then my skill map shows "Kubernetes" rated "4/5 · Advanced"
    And my skill map shows no rating form
