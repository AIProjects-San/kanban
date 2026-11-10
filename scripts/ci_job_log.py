#!/usr/bin/env python3
"""Download a CI job's log without printing the token.

Usage: python3 scripts/ci_job_log.py <job_id> [grep pattern]
"""
import json
import subprocess
import sys
import urllib.request


def main() -> int:
    token, repo = None, None
    remote = subprocess.check_output(
        ["git", "remote", "get-url", "origin"], text=True
    ).strip()
    if "@github.com/" in remote:
        creds, rest = remote.split("@github.com/", 1)
        token = creds.rsplit(":", 1)[1] if ":" in creds else ""
        repo = rest.removesuffix(".git")
    if not token or not repo:
        print("could not parse token/repo", file=sys.stderr)
        return 1
    job_id = sys.argv[1]
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/jobs/{job_id}/logs",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            log = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}", file=sys.stderr)
        return 1
    # Follow the redirect: urllib handles 302 to the log URL automatically.
    lines = log.splitlines()
    pattern = sys.argv[2] if len(sys.argv) > 2 else None
    if pattern:
        import re

        rx = re.compile(pattern, re.I)
        hits = [l for l in lines if rx.search(l)]
        print(f"{len(hits)} matching line(s); last 40:")
        for l in hits[-40:]:
            print(l[:300])
    else:
        print(f"{len(lines)} lines; last 60:")
        for l in lines[-60:]:
            print(l[:300])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
