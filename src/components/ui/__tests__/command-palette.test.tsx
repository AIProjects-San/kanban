import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Command palette — drift regression tests
//
// These tests pin the contract that the cmdk palette's Navigation and Create
// groups must stay in sync with the Sidebar's nav items and the per-view
// create-buttons. The original drift was:
//   - "Invite team member" entry opened the obsolete MemberModal "Create
//     new" tab.
//   - "rbac" Navigation entry led to a blank screen (no AppShell branch).
//   - Navigation was missing projects/users/workspace-settings.
//   - "Create new project" was missing its P hint.
//   - No "Create user" entry existed (the modern replacement for the
//     old MemberModal "Create new" flow).
// ---------------------------------------------------------------------------

// Stub next-auth/react's useSession so we can drive role-gating.
const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock("next-auth/react", () => ({
  useSession,
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Stub the server-actions/data barrel so MemberModal's getAllUsers call (if
// it ever fires) doesn't reach the network.
vi.mock("@/server-actions/data", () => ({
  getAllUsers: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  createMember: vi.fn(),
}));

import { CommandPalette } from "@/components/ui/command-palette";
import { useApp } from "@/store/app-store";

function openPalette() {
  useApp.getState().setCmdkOpen(true);
}

function closePalette() {
  useApp.getState().setCmdkOpen(false);
}

beforeEach(() => {
  useSession.mockReturnValue({ data: { user: { role: "ADMIN" } } });
  openPalette();
});

afterEach(() => {
  closePalette();
  vi.clearAllMocks();
});

// Helper — collect every visible button label inside the palette.
function paletteLabels(): string[] {
  const buttons = screen.queryAllByRole("button");
  return buttons
    .map((b) => b.textContent?.trim() ?? "")
    .filter((s) => s.length > 0);
}

describe("command palette: navigation drift contract", () => {
  it("exposes Go to Projects (was missing — drift fix)", async () => {
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).toContain("Go to Projects");
    });
  });

  it("exposes Go to Users for admins (was missing — drift fix)", async () => {
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).toContain("Go to Users");
    });
  });

  it("exposes Go to Workspace Config for admins (was missing — drift fix)", async () => {
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).toContain("Go to Workspace Config");
    });
  });

  it("exposes Go to Audit Log for admins", async () => {
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).toContain("Go to Audit Log");
    });
  });

  it("does NOT expose the broken 'Go to Roles & Permissions' entry (rbac view removed)", async () => {
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).not.toContain("Go to Roles & Permissions");
    });
  });
});

describe("command palette: create-group drift contract", () => {
  it("does NOT expose 'Invite team member' (removed — opens obsolete modal)", async () => {
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).not.toContain("Invite team member");
    });
  });

  it("exposes 'Create user' for admins (replaces the old MemberModal flow)", async () => {
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).toContain("Create user");
    });
  });

  it("exposes 'Create new task' with the N hint", async () => {
    render(<CommandPalette />);
    const taskBtn = await screen.findByRole("button", { name: /create new task/i });
    // The hint is rendered inside a <kbd> child of the button.
    const kbd = taskBtn.querySelector("kbd");
    expect(kbd).not.toBeNull();
    expect(kbd?.textContent).toBe("N");
  });

  it("exposes 'Create new project' with the P hint (hint was missing — drift fix)", async () => {
    render(<CommandPalette />);
    const projectBtn = await screen.findByRole("button", { name: /create new project/i });
    const kbd = projectBtn.querySelector("kbd");
    expect(kbd).not.toBeNull();
    expect(kbd?.textContent).toBe("P");
  });
});

describe("command palette: role gating", () => {
  it("hides Users / Workspace Config / Create user from non-admins", async () => {
    useSession.mockReturnValue({ data: { user: { role: "MEMBER" } } });
    render(<CommandPalette />);
    await waitFor(() => {
      const labels = paletteLabels();
      expect(labels).not.toContain("Go to Users");
      expect(labels).not.toContain("Go to Workspace Config");
      expect(labels).not.toContain("Create user");
    });
  });

  it("hides Go to Audit Log from non-audit viewers (MEMBER role)", async () => {
    useSession.mockReturnValue({ data: { user: { role: "MEMBER" } } });
    render(<CommandPalette />);
    await waitFor(() => {
      expect(paletteLabels()).not.toContain("Go to Audit Log");
    });
  });
});

describe("command palette: query filtering", () => {
  it("narrows results to matches", async () => {
    render(<CommandPalette />);
    await waitFor(() => expect(paletteLabels().length).toBeGreaterThan(0));
    const input = screen.getByPlaceholderText("Type a command or search…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "audit" } });
    await waitFor(() => {
      const labels = paletteLabels();
      // The audit log entry survives; users / projects / create-user etc. don't.
      expect(labels.some((l) => l.toLowerCase().includes("audit"))).toBe(true);
      expect(labels.some((l) => l.toLowerCase().includes("create new task"))).toBe(false);
    });
  });
});
