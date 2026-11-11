@hr-onboarding
Feature: HR onboarding checklists
  HR starts a per-hire checklist from the default template (manager tasks
  auto-assigned); the hire and task assignees tick their own tasks from
  Settings; the checklist auto-completes when the last task is ticked.

  Background:
    Given the app is running

  Scenario: HR sees the seeded checklists with progress
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Onboarding" tab
    Then the onboarding checklist "Nov 2026 onboarding — Diego" should show 1 of 5 tasks done
    And the onboarding checklist "Nov 2026 onboarding — Hana" should show 2 of 3 tasks done

  Scenario: HR creates a checklist from the template
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Onboarding" tab
    And I start onboarding for "Soren Lindqvist" titled "E2E template onboarding"
    Then the onboarding checklist "E2E template onboarding" should show 0 of 5 tasks done

  Scenario: HR adds a task to an in-progress checklist
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Onboarding" tab
    And I add the task "Order the second monitor" to "Nov 2026 onboarding — Diego"
    Then the onboarding checklist "Nov 2026 onboarding — Diego" should show 1 of 6 tasks done

  Scenario: The checklist auto-completes when the last task is ticked
    When I sign in as "priya@fernly.app" with the demo password
    And I open the "Settings" view
    And I complete my onboarding task "Meet your manager for the 1:1 kick-off"
    Then my onboarding checklist "Nov 2026 onboarding — Hana" should be complete

  Scenario: The hire ticks their own template task
    The hire sees their whole remaining checklist (manager tasks included);
    the extra task added earlier by HR also counts.
    When I sign in as "diego@fernly.app" with the demo password
    And I open the "Settings" view
    And I complete my onboarding task "Complete the workspace tour"
    Then my onboarding list should show 4 remaining tasks

  Scenario: A member outside the checklist cannot tick its tasks
    When I sign in as "member@fernly.app" with the demo password
    And I open the "Settings" view
    Then my onboarding list should show no tasks

  # P35 (EM-12/EM-B06/EM-11) — template depth: the derived boarding status,
  # the required flag, the role-scoped assignee, and holiday-aware due dates.

  Scenario: The derived boarding status chip renders on the seeded checklist
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Onboarding" tab
    Then the onboarding checklist "Nov 2026 onboarding — Diego" should show the status "in progress"
    And the onboarding checklist "Nov 2026 onboarding — Diego" should show 1 required task open
    And the onboarding task "Set up accounts and SSO access" should show "the HR role" as its assignee
    And the onboarding task "Set up accounts and SSO access" should be due on "11 Nov"

  Scenario: The template editor chips show the assignee axis and the required flag
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Onboarding" tab
    Then the template task "Revoke accounts, SSO and tool access" should show "HR role" in its chip
    And the template task "Sign the employment contract" should show "required" in its chip

  Scenario: HR pins the checklist start date and the tasks get holiday-aware due dates
    When I sign in as "demo@fernly.app" with the demo password
    And I open the "HR" view
    And I open the "Onboarding" tab
    And I start onboarding for "Soren Lindqvist" titled "E2E dated onboarding" starting "2026-11-09"
    Then the onboarding task "Sign the employment contract" on "E2E dated onboarding" should be due on "10 Nov"
    And the onboarding task "Complete the workspace tour" on "E2E dated onboarding" should be due on "16 Nov"
