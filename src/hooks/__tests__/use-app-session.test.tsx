// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Persona-audit CI stabilization round 3 — useAppSession status mapping.
//
// better-auth's session atom KEEPS `data` and sets `error` on a transient
// get-session failure (network/5xx) while it CLEARS data on a 401. The old
// mapping checked `error` first, so a single failed background refetch
// flipped status to "unauthenticated" → AppShell rendered LoginScreen →
// the active view unmounted mid-use (and mid-e2e-step). These tests pin the
// precedence: live data wins, definitive 401/403 rejects, transient errors
// hold as "loading", clean-null resolves as "unauthenticated".
// ---------------------------------------------------------------------------

const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }));

vi.mock("@/lib/auth/auth-client-better", () => ({
  authClient: { useSession },
}));

import { useAppSession } from "@/hooks/use-app-session";

const SESSION = { user: { id: "u-1", name: "Remy", email: "r@x.co", role: "HR" } };

function mockUseSession(overrides: Partial<{ data: unknown; isPending: boolean; error: unknown }>) {
  useSession.mockReturnValue({
    data: null,
    isPending: false,
    error: null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSession({});
});

describe("useAppSession status mapping", () => {
  it("reports authenticated for a live session", () => {
    mockUseSession({ data: SESSION });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.status).toBe("authenticated");
    expect(result.current.data?.user.email).toBe("r@x.co");
  });

  it("KEEPS authenticated when a background refetch failed but data is held (the regression)", () => {
    // better-auth on a transient network failure: { data: <kept>, error: TypeError }.
    // The old mapping returned "unauthenticated" here, tearing down the shell.
    mockUseSession({ data: SESSION, error: new TypeError("Failed to fetch") });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.status).toBe("authenticated");
    expect(result.current.data?.user.id).toBe("u-1");
  });

  it("reports unauthenticated on a definitive 401 with no data", () => {
    mockUseSession({ data: null, error: { status: 401, message: "Unauthorized" } });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.status).toBe("unauthenticated");
    expect(result.current.data).toBeNull();
  });

  it("reports unauthenticated on a definitive 403 with no data", () => {
    mockUseSession({ data: null, error: { status: 403 } });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.status).toBe("unauthenticated");
  });

  it("reports loading on a transient error with no data yet (shell holds, store retries)", () => {
    mockUseSession({ data: null, isPending: false, error: new TypeError("Failed to fetch") });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();
  });

  it("reports loading while the first fetch is pending", () => {
    mockUseSession({ data: null, isPending: true });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.status).toBe("loading");
  });

  it("reports unauthenticated on a clean resolve with no session (signed out)", () => {
    mockUseSession({ data: null, isPending: false, error: null });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.status).toBe("unauthenticated");
    expect(result.current.data).toBeNull();
  });

  it("defaults a missing role to MEMBER in the normalised session", () => {
    mockUseSession({ data: { user: { id: "u-2", name: "M", email: "m@x.co" } } });
    const { result } = renderHook(() => useAppSession());
    expect(result.current.data?.user.role).toBe("MEMBER");
  });
});
