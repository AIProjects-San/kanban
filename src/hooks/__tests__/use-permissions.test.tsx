// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// PR-64 — usePermissions consults the SERVER-computed effective permission
// set (static floor ∪ DB ceiling) once it is loaded, and falls back to the
// static matrix before that (pre-hydration / tests). This is what makes an
// admin's role-permission save reflect for already-logged-in users.
// ---------------------------------------------------------------------------

const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));

vi.mock("@/lib/auth/auth-client-better", () => ({
  authClient: { useSession },
}));

import { usePermissions } from "@/hooks/use-permissions";
import { useApp } from "@/store/app-store";

function signIn(role: string) {
  useSession.mockReturnValue({
    data: { user: { id: "u-1", name: "N", email: "n@x.co", role } },
    isPending: false,
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn("MEMBER");
  // Fresh store state: effectivePermissions NOT loaded → static fallback.
  useApp.setState({ effectivePermissions: null });
});

describe("usePermissions: static fallback (not loaded)", () => {
  it("uses the hardcoded matrix when the server set has not loaded", () => {
    const { result } = renderHook(() => usePermissions());
    expect(result.current.role).toBe("MEMBER");
    expect(result.current.can("task:edit:own")).toBe(true); // static grant
    expect(result.current.can("hr:view")).toBe(false); // no static grant
  });
});

describe("usePermissions: effective set overrides the static matrix", () => {
  it("a DB-granted permission (via the server set) passes `can`", () => {
    const { result } = renderHook(() => usePermissions());
    act(() => {
      // The admin granted MEMBER hr:view in the role editor; the
      // getMyPermissions poll delivered it.
      useApp.getState().setEffectivePermissions(["task:edit:own", "hr:view"]);
    });
    expect(result.current.can("hr:view")).toBe(true);
  });

  it("a permission missing from the server set is denied even if the static matrix grants it", () => {
    // Defensive mirror of the deny-safe server contract: the server set is
    // the source of truth once loaded.
    const { result } = renderHook(() => usePermissions());
    act(() => {
      useApp.getState().setEffectivePermissions(["hr:view"]);
    });
    expect(result.current.can("hr:view")).toBe(true);
    expect(result.current.can("task:edit:own")).toBe(false);
  });
});
