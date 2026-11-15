#!/usr/bin/env python3
"""Query the jobs of a GitHub Actions run without printing the token.

Usage: python3 scripts/ci_jobs.py <run_id> [--logs <job_id>]
"""
import json
import subprocess
import sys
import urllib.request


def get_token_and_repo():
    remote = subprocess.check_output(
        ["git", "remote", "get-url", "origin"], text=True
    ).strip()
    if "@github.com/" not in remote:
        return None, None
    creds, rest = remote.split("@github.com/", 1)
    token = creds.rsplit(":", 1)[1] if ":" in creds else ""
    repo = rest.removesuffix(".git")
    return token, repo


def api(token, repo, path):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def main() -> int:
    token, repo = get_token_and_repo()
    if not token or not repo:
        print("could not parse token/repo from remote", file=sys.stderr)
        return 1
    run_id = sys.argv[1]
    jobs = api(token, repo, f"actions/runs/{run_id}/jobs?per_page=50")
    for j in jobs.get("jobs", []):
        print(f"{j['id']}\t{j['name']}\t{j['status']}\t{j['conclusion']}")
        for s in j.get("steps", []) or []:
            if s.get("conclusion") not in ("success", "skipped", None):
                print(f"    step FAILED: {s['name']} -> {s['conclusion']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
