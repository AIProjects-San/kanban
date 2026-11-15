#!/usr/bin/env python3
"""Map each view/component/admin page to the server actions it imports."""
import re, os, glob

ROOTS = [
    "/home/z/my-project/src/components/views",
    "/home/z/my-project/src/components/admin",
    "/home/z/my-project/src/components/auth",
    "/home/z/my-project/src/components/offer",
    "/home/z/my-project/src/app",
]
ACTION_RE = re.compile(r'from\s+["\']@/server-actions/([a-z-]+)["\']')

for root in ROOTS:
    for path in sorted(glob.glob(os.path.join(root, "**", "*.tsx"), recursive=True)):
        src = open(path).read()
        mods = sorted(set(ACTION_RE.findall(src)))
        if mods:
            rel = os.path.relpath(path, "/home/z/my-project")
            print(f"{rel}\n    -> {', '.join(mods)}")
