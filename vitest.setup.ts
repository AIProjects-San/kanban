import "@testing-library/jest-dom/vitest";

// Suppress the expected console noise (dev secret warning, audit failures)
// during tests so the output stays readable.
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("[auth] NEXTAUTH_SECRET")) return;
  origWarn(...args);
};
