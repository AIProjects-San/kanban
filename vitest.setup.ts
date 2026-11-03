import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Suppress the expected console noise (dev secret warning, audit failures)
// during tests so the output stays readable.
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("[auth-better] secret not set")) return;
  origWarn(...args);
};

// Mock next/navigation's useRouter so components that call useRefresh()
// (which depends on useRouter) don't crash in jsdom. The mock object is
// hoisted OUTSIDE the factory so it's stable across renders — this matters
// because production useRouter() returns a stable AppRouter instance, and
// useRefresh's useCallback identity depends on it. A fresh object per call
// would silently break child memoization in tests.
const mockRouter = {
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => mockRouter,
  };
});


