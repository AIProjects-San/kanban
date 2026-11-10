// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// P24 (PL-01) — the notification template editor (Settings → Notifications).
// Pins the editor's contract: both registry events render as cards, an
// uncustomized event starts from the DEFAULT templates and wears the
// "System default" badge, an override row wears "Customized" and prefills
// its text, the live preview renders through the shared kernel, and
// Save/Reset call the actions with the right payload.
// ---------------------------------------------------------------------------

const { loadWorkspaceConfig, updateNotificationTemplate, resetNotificationTemplate } = vi.hoisted(() => ({
  loadWorkspaceConfig: vi.fn(),
  updateNotificationTemplate: vi.fn(),
  resetNotificationTemplate: vi.fn(),
}));

vi.mock("@/server-actions/data", () => ({
  loadWorkspaceConfig,
  updateNotificationTemplate,
  resetNotificationTemplate,
  updateWorkspaceSettings: vi.fn(),
  updateConfigItem: vi.fn(),
  createConfigItem: vi.fn(),
  deleteConfigItem: vi.fn(),
  updateRole: vi.fn(),
  createRole: vi.fn(),
  deleteRole: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/use-refresh", () => ({ useRefresh: () => () => Promise.resolve() }));

import { WorkspaceSettingsView } from "@/components/views/workspace-settings-view";
import type { WorkspaceConfig } from "@/lib/config-loader";
import { NOTIFICATION_TEMPLATE_EVENTS } from "@/lib/notification-template";

function baseConfig(notificationTemplates: WorkspaceConfig["notificationTemplates"]): WorkspaceConfig {
  return {
    workspace: {
      name: "Fernly Workspace", defaultTimezone: "Pacific/Auckland", defaultUserRole: "MEMBER",
      defaultDepartment: "ENGINEERING", defaultAvatarColor: "forest", defaultJobTitle: "Team Member",
      minPasswordLength: 8, workloadFullCapacity: 6, auditLogLimit: 300, auditRetentionDays: 180,
      entityHistoryLimit: 50, dashboardNotifLimit: 20, hiringEmailDomain: "fernly.app",
      joiningGateEnabled: true, attendanceDayStart: "09:00", attendanceDayEnd: "17:30",
      unmarkedAttendanceMode: "IGNORED", payrollRoundingMode: "ROUND_2DP", overtimePayEnabled: false,
      fiscalYearStartMonth: 1, lopBasisMode: "HYBRID", showLeaveBalancesOnSlip: false,
      emailPayslipsOnLock: false, emailLeaveNotifications: false,
      remindBirthdays: true, remindAnniversaries: true, remindHolidays: true,
      holidayReminderDaysAhead: 7, emailEngagementReminders: false,
    },
    mail: { configured: false, provider: "none" },
    taskStatuses: [], projectStatuses: [], eventTypes: [], taskTags: [], priorities: [],
    departments: [], roles: [], permissions: [],
    notificationTemplates,
  };
}

const CURRENT_USER = { id: "u-admin", name: "Mira Hale", role: "ADMIN" };

async function openNotificationsTab() {
  const tab = await screen.findByTestId("settings-tab-notification-templates");
  fireEvent.click(tab);
  await waitFor(() => expect(screen.getByTestId("notification-template-card-LEAVE_PENDING")).toBeTruthy());
}

beforeEach(() => {
  vi.clearAllMocks();
  loadWorkspaceConfig.mockResolvedValue({ ok: true, data: baseConfig([]) });
  updateNotificationTemplate.mockResolvedValue({ ok: true, data: undefined });
  resetNotificationTemplate.mockResolvedValue({ ok: true, data: undefined });
});

describe("P24 — the notification template editor", () => {
  it("renders one card per registry event, system-default badges, and the default text prefilled", async () => {
    render(<WorkspaceSettingsView currentUser={CURRENT_USER} />);
    await openNotificationsTab();

    for (const def of NOTIFICATION_TEMPLATE_EVENTS) {
      expect(screen.getByTestId(`notification-template-card-${def.eventKey}`)).toBeTruthy();
      expect(screen.getByTestId(`tpl-badge-${def.eventKey}`).textContent).toBe("System default");
      // The uncustomized card starts from the DEFAULT template text.
      expect((screen.getByTestId(`tpl-title-${def.eventKey}`) as HTMLInputElement).value).toBe(def.defaults.title);
      expect((screen.getByTestId(`tpl-subject-${def.eventKey}`) as HTMLInputElement).value).toBe(def.defaults.subject);
    }
    // The pending message field carries the default with placeholders.
    const pending = NOTIFICATION_TEMPLATE_EVENTS.find((e) => e.eventKey === "LEAVE_PENDING")!;
    expect((screen.getByTestId("tpl-message-LEAVE_PENDING") as HTMLTextAreaElement).value).toBe(pending.defaults.message);
  });

  it("the live preview renders through the shared kernel with the registry's samples", async () => {
    render(<WorkspaceSettingsView currentUser={CURRENT_USER} />);
    await openNotificationsTab();

    // Default LEAVE_PENDING title has no placeholders → renders as-is.
    expect(screen.getByTestId("tpl-preview-title-LEAVE_PENDING").textContent).toBe("Leave request awaiting your approval");
    // The message renders the samples (Theo Vance / Annual Leave).
    expect(screen.getByTestId("tpl-preview-message-LEAVE_PENDING").textContent).toBe(
      "Theo Vance requested 2 day(s) of Annual Leave (2027-03-08 → 2027-03-09).",
    );
  });

  it("typing + Save calls updateNotificationTemplate with the edited payload", async () => {
    render(<WorkspaceSettingsView currentUser={CURRENT_USER} />);
    await openNotificationsTab();

    const message = screen.getByTestId("tpl-message-LEAVE_PENDING") as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "{{requesterName}} → {{daysCount}}d {{typeName}} 🌴" } });
    fireEvent.click(screen.getByTestId("tpl-save-LEAVE_PENDING"));

    await waitFor(() => expect(updateNotificationTemplate).toHaveBeenCalledTimes(1));
    expect(updateNotificationTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "LEAVE_PENDING",
        message: "{{requesterName}} → {{daysCount}}d {{typeName}} 🌴",
      }),
    );
  });

  it("an override row wears the Customized badge, prefills its text, and Reset calls the reset action", async () => {
    loadWorkspaceConfig.mockResolvedValue({
      ok: true,
      data: baseConfig([{
        eventKey: "LEAVE_PENDING",
        subjectTemplate: "Ping: {{typeName}}",
        bodyTemplate: "Body {{requesterName}}",
        titleTemplate: "T {{typeName}}",
        messageTemplate: "M {{requesterName}}",
      }]),
    });
    render(<WorkspaceSettingsView currentUser={CURRENT_USER} />);
    await openNotificationsTab();

    expect(screen.getByTestId("tpl-badge-LEAVE_PENDING").textContent).toBe("Customized");
    expect((screen.getByTestId("tpl-subject-LEAVE_PENDING") as HTMLInputElement).value).toBe("Ping: {{typeName}}");
    // The other event stays system-default.
    expect(screen.getByTestId("tpl-badge-LEAVE_DECIDED").textContent).toBe("System default");

    fireEvent.click(screen.getByTestId("tpl-reset-LEAVE_PENDING"));
    await waitFor(() => expect(resetNotificationTemplate).toHaveBeenCalledWith({ eventKey: "LEAVE_PENDING" }));
  });

  it("a refused save surfaces the server's message and never flips the badge", async () => {
    updateNotificationTemplate.mockResolvedValue({
      ok: false,
      error: "Unknown placeholder(s) — message: {{dayz}}. Variables available for Leave request awaiting approval: {{requesterName}}, …",
    });
    render(<WorkspaceSettingsView currentUser={CURRENT_USER} />);
    await openNotificationsTab();

    const message = screen.getByTestId("tpl-message-LEAVE_PENDING") as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "{{dayz}}" } });
    fireEvent.click(screen.getByTestId("tpl-save-LEAVE_PENDING"));

    await waitFor(() => expect(updateNotificationTemplate).toHaveBeenCalledTimes(1));
    // The badge still says system default (nothing persisted), and the
    // edited text is still in the field (the admin can fix the typo).
    expect(screen.getByTestId("tpl-badge-LEAVE_PENDING").textContent).toBe("System default");
    expect((screen.getByTestId("tpl-message-LEAVE_PENDING") as HTMLTextAreaElement).value).toBe("{{dayz}}");
  });
});
