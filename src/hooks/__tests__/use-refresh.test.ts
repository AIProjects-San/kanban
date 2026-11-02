import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/navigation's useRouter before importing the hook.
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// Mock the zustand store's bumpRefresh — we want to assert it gets called
// after router.refresh(), but we don't want the test to depend on the
// store's full implementation.
const mockBumpRefresh = vi.fn();
vi.mock("@/store/app-store", () => ({
  useApp: {
    getState: () => ({ bumpRefresh: mockBumpRefresh }),
  },
}));

import { useRefresh } from "../use-refresh";
import { renderHook } from "@testing-library/react";

describe("useRefresh (L-P0-1 fix)", () => {
  beforeEach(() => {
    mockRefresh.mockClear();
    mockBumpRefresh.mockClear();
  });

  it("calls router.refresh() then bumpRefresh() in that order", () => {
    const { result } = renderHook(() => useRefresh());
    result.current();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockBumpRefresh).toHaveBeenCalledTimes(1);
    // Pin the contract: router.refresh() must fire BEFORE bumpRefresh().
    // If someone swaps the order, AppShell's `key={view-refreshTick}` would
    // change BEFORE the new server props land, causing a one-frame flash of
    // stale data on the remounted view.
    expect(mockRefresh).toHaveBeenCalledBefore(mockBumpRefresh);
  });

  it("exposes a function (caller can invoke after a mutation)", () => {
    const { result } = renderHook(() => useRefresh());
    expect(typeof result.current).toBe("function");
    result.current();
    expect(mockRefresh).toHaveBeenCalled();
  });
});
