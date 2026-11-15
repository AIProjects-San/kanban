#!/usr/bin/env python3
"""Query GitHub Actions runs for this repo without printing the token.

Token is read from the git remote URL; only run metadata is printed.
"""
import json
import subprocess
import sys
import urllib.request


def main() -> int:
    remote = subprocess.check_output(
        ["git", "remote", "get-url", "origin"], text=True
    ).strip()
    token = ""
    repo = ""
    if "@github.com/" in remote:
        creds, rest = remote.split("@github.com/", 1)
        token = creds.rsplit(":", 1)[1] if ":" in creds else ""
        repo = rest.removesuffix(".git")
    if not token or not repo:
        print("could not parse token/repo from remote", file=sys.stderr)
        return 1

    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/runs?per_page=15",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        data = json.load(resp)
    runs = data.get("workflow_runs")
    if runs is None:
        print(json.dumps(data)[:500])
        return 0
    for r in runs:
        print(
            f"{r['id']}\t{r['head_sha'][:8]}\t{r['name']}\t"
            f"{r['status']}\t{r['conclusion']}\t{r['created_at']}\t{r['event']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
