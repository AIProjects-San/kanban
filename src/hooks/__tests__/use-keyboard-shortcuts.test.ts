import { describe, it, expect, vi, beforeEach } from "vitest";

// L-P0-15 regression — G U / G W / G L must be gated by the same permissions
// the sidebar uses.

const mockSetView = vi.fn();
const mockOpenTaskModal = vi.fn();
const mockOpenProjectModal = vi.fn();
const mockSetShortcutsOpen = vi.fn();
const mockSetNotifOpen = vi.fn();
const mockToggleSidebarRail = vi.fn();

vi.mock("@/store/app-store", () => ({
  useApp: () => ({
    setView: mockSetView,
    openTaskModal: mockOpenTaskModal,
    openProjectModal: mockOpenProjectModal,
    setShortcutsOpen: mockSetShortcutsOpen,
    setNotifOpen: mockSetNotifOpen,
    sidebarRail: false,
    toggleSidebarRail: mockToggleSidebarRail,
  }),
}));

// PR-65 — ⌘B also persists the rail per-user; keep it inert in tests.
const mockPersistAppearance = vi.fn();
vi.mock("@/hooks/use-appearance-sync", () => ({
  usePersistAppearance: () => mockPersistAppearance,
}));

let currentPermissions: Set<string> = new Set();
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    role: "TEST",
    can: (perm: string) => currentPermissions.has(perm),
  }),
}));

import { useKeyboardShortcuts } from "../use-keyboard-shortcuts";
import { renderHook } from "@testing-library/react";

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function gPress(key: string) {
  pressKey("g");
  pressKey(key);
}

describe("useKeyboardShortcuts (L-P0-15 shortcut permission gating)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentPermissions = new Set();
  });

  it("allows G D (dashboard) for any role — no gate", () => {
    renderHook(() => useKeyboardShortcuts());
    gPress("d");
    expect(mockSetView).toHaveBeenCalledWith("dashboard");
  });

  it("allows G T (tasks) for any role — no gate", () => {
    renderHook(() => useKeyboardShortcuts());
    gPress("t");
    expect(mockSetView).toHaveBeenCalledWith("tasks");
  });

  it("blocks G U (users) when the role lacks role:manage (MEMBER)", () => {
    currentPermissions = new Set();
    renderHook(() => useKeyboardShortcuts());
    gPress("u");
    expect(mockSetView).not.toHaveBeenCalled();
  });

  it("allows G U (users) when the role has role:manage (ADMIN)", () => {
    currentPermissions = new Set(["role:manage"]);
    renderHook(() => useKeyboardShortcuts());
    gPress("u");
    expect(mockSetView).toHaveBeenCalledWith("users");
  });

  it("blocks G W (workspace-settings) when the role lacks role:manage", () => {
    currentPermissions = new Set();
    renderHook(() => useKeyboardShortcuts());
    gPress("w");
    expect(mockSetView).not.toHaveBeenCalled();
  });

  it("allows G W (workspace-settings) when the role has role:manage", () => {
    currentPermissions = new Set(["role:manage"]);
    renderHook(() => useKeyboardShortcuts());
    gPress("w");
    expect(mockSetView).toHaveBeenCalledWith("workspace-settings");
  });

  it("blocks G L (audit) when the role lacks audit:view (MEMBER)", () => {
    currentPermissions = new Set();
    renderHook(() => useKeyboardShortcuts());
    gPress("l");
    expect(mockSetView).not.toHaveBeenCalled();
  });

  it("allows G L (audit) when the role has audit:view (MANAGER)", () => {
    currentPermissions = new Set(["audit:view"]);
    renderHook(() => useKeyboardShortcuts());
    gPress("l");
    expect(mockSetView).toHaveBeenCalledWith("audit");
  });

  it("blocks G L (audit) for a role that has role:manage but NOT audit:view", () => {
    currentPermissions = new Set(["role:manage"]);
    renderHook(() => useKeyboardShortcuts());
    gPress("l");
    expect(mockSetView).not.toHaveBeenCalled();
  });

  // Regression (caught by the e2e suite): the single-key bindings used to run
  // BEFORE the G-prefix map, so the second key of a G-sequence was consumed
  // by the single-key handler — G P opened the project MODAL and G B opened
  // the notification panel, making two documented sidebar bindings
  // unreachable. The single-key handlers must defer while a G is pending.
  it("G P switches to the projects view instead of opening the project modal", () => {
    renderHook(() => useKeyboardShortcuts());
    gPress("p");
    expect(mockSetView).toHaveBeenCalledWith("projects");
    expect(mockOpenProjectModal).not.toHaveBeenCalled();
  });

  it("G B switches to the bugs view instead of opening notifications", () => {
    renderHook(() => useKeyboardShortcuts());
    gPress("b");
    expect(mockSetView).toHaveBeenCalledWith("bugs");
    expect(mockSetNotifOpen).not.toHaveBeenCalled();
  });

  // Persona-audit P0-1 review: same shadow class for n/i — G N must reach
  // the My Payslips view (not the task modal) and G I the Hiring view (not
  // the inbox drawer).
  it("G N switches to the my-payslips view instead of opening the task modal", () => {
    renderHook(() => useKeyboardShortcuts());
    gPress("n");
    expect(mockSetView).toHaveBeenCalledWith("my-payslips");
    expect(mockOpenTaskModal).not.toHaveBeenCalled();
  });

  it("G I switches to the hiring view instead of opening the inbox drawer", () => {
    // Hiring is permission-gated (hiring:view) — grant it, else the G I
    // binding correctly no-ops for a permission-less session.
    currentPermissions = new Set(["hiring:view"]);
    renderHook(() => useKeyboardShortcuts());
    gPress("i");
    expect(mockSetView).toHaveBeenCalledWith("hiring");
  });

  it("a lone p (no pending G) still opens the project modal", () => {
    renderHook(() => useKeyboardShortcuts());
    pressKey("p");
    expect(mockOpenProjectModal).toHaveBeenCalledTimes(1);
    expect(mockSetView).not.toHaveBeenCalled();
  });

  it("a lone b (no pending G) still opens the notification panel", () => {
    renderHook(() => useKeyboardShortcuts());
    pressKey("b");
    expect(mockSetNotifOpen).toHaveBeenCalledTimes(1);
    expect(mockSetView).not.toHaveBeenCalled();
  });
});

describe("useKeyboardShortcuts (PR-58 sidebar rail toggle)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentPermissions = new Set();
  });

  function pressKeyWithMeta(key: string) {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true })
    );
  }

  it("⌘B toggles the sidebar rail", () => {
    renderHook(() => useKeyboardShortcuts());
    pressKeyWithMeta("b");
    expect(mockToggleSidebarRail).toHaveBeenCalledTimes(1);
    // And it must NOT fall through to the single-key "b" (notifications).
    expect(mockSetNotifOpen).not.toHaveBeenCalled();
    expect(mockSetView).not.toHaveBeenCalled();
  });

  it("a bare B without a modifier still opens notifications, not the rail toggle", () => {
    renderHook(() => useKeyboardShortcuts());
    pressKey("b");
    expect(mockSetNotifOpen).toHaveBeenCalledTimes(1);
    expect(mockToggleSidebarRail).not.toHaveBeenCalled();
  });
});
