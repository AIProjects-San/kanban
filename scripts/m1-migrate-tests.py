#!/usr/bin/env python3
"""PR-49 milestone 1 — migrate the 5 mechanical server-action test files
from the next-auth getServerSession mock to the Better Auth getBetterSession
mock (the repo default stack is now "better")."""
import re
import sys

FILES = [
    "src/server-actions/__tests__/data.test.ts",
    "src/server-actions/__tests__/data-crud.test.ts",
    "src/server-actions/__tests__/data-branches.test.ts",
    "src/server-actions/__tests__/messages-p0-2.test.ts",
    "src/server-actions/__tests__/breach-wiring.test.ts",
]

OLD_MOCK = 'vi.mock("next-auth", () => ({ getBetterSession }));'
NEW_MOCK = (
    'vi.mock("@/lib/auth-better", () => ({\n'
    "  // The Better Auth session seam (PR-49 default stack). revokeUserSessions\n"
    "  // is stubbed so password-change flows that call the revocation bridge\n"
    "  // never touch a real instance.\n"
    "  getBetterSession,\n"
    "  revokeUserSessions: vi.fn(),\n"
    "}));"
)

OLD_SHAPE = (
    "user ? { user: { id: user.userId, name: user.name, email: user.email, role: user.role } } : null"
)
NEW_SHAPE = (
    "user ? { userId: user.userId, name: user.name, email: user.email, role: user.role } : null"
)

OLD_BREACH_FIXTURE = """const ADMIN_SESSION = {
  user: { id: "admin-1", email: "mira@fernly.app", name: "Mira Hale", role: "ADMIN" },
};"""
NEW_BREACH_FIXTURE = """const ADMIN_SESSION = {
  userId: "admin-1", email: "mira@fernly.app", name: "Mira Hale", role: "ADMIN",
};"""

for path in FILES:
    with open(path) as f:
        src = f.read()
    orig = src

    # 1. Rename the mock identifier everywhere it appears.
    src = src.replace("getServerSession", "getBetterSession")

    # 2. Retarget the module mock.
    if OLD_MOCK not in src:
        sys.exit(f"FAIL {path}: mock line not found after rename")
    src = src.replace(OLD_MOCK, NEW_MOCK)

    # 3. Flatten the next-auth Session fixture shape -> AuthResult shape.
    src = src.replace(OLD_SHAPE, NEW_SHAPE)

    # 4. breach-wiring's ADMIN_SESSION fixture.
    src = src.replace(OLD_BREACH_FIXTURE, NEW_BREACH_FIXTURE)

    # 5. Freshen the header comments that named next-auth.
    src = src.replace("next-auth session, and next/cache", "Better Auth session, and next/cache")
    src = src.replace("Mock next-auth's getBetterSession", "Mock the Better Auth session helper")

    if src == orig:
        sys.exit(f"FAIL {path}: no changes applied")
    with open(path, "w") as f:
        f.write(src)
    print(f"OK {path}")
print("done")
