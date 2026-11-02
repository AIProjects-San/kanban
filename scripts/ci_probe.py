#!/usr/bin/env python3
"""Probe CI runs: job/step status for the latest runs, and fetch logs of failed jobs."""
import json
import sys
import urllib.request
import urllib.error

REPO = "AIProjects-San/kanban"
TOKEN = open("/tmp/gh_token").read().strip()
HEADERS = {
    "Authorization": f"token {TOKEN}",
    "Accept": "application/vnd.github+json",
    "User-Agent": "ci-debug-script",
}


def get(url, timeout=40):
    req = urllib.request.Request(url, headers=HEADERS)
    return urllib.request.urlopen(req, timeout=timeout)


def jobs_for_run(run_id):
    d = json.load(get(f"https://api.github.com/repos/{REPO}/actions/runs/{run_id}/jobs"))
    return d["jobs"]


def print_jobs(run_id, label):
    jobs = jobs_for_run(run_id)
    print(f"=== run {run_id} ({label}) ===")
    failed_jobs = []
    for j in jobs:
        print(
            f"  job {j['id']} | {j['name']} | {j['status']} | {j['conclusion']}"
        )
        for s in j.get("steps", []):
            mark = ""
            if s["conclusion"] not in ("success", "skipped") and s["conclusion"] is not None:
                mark = "   <<<< FAILED STEP"
            if s["conclusion"] is None and s["status"] in ("in_progress", "queued"):
                mark = "   (running)"
            print(f"      step: {s['name']} [{s['status']}/{s['conclusion']}]{mark}")
        if j["conclusion"] == "failure":
            failed_jobs.append(j)
    return failed_jobs


def fetch_log(job_id, out_path):
    try:
        resp = get(f"https://api.github.com/repos/{REPO}/actions/jobs/{job_id}/logs", timeout=90)
        data = resp.read().decode("utf-8", errors="replace")
        with open(out_path, "w") as f:
            f.write(data)
        return len(data)
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"


def summarize_log(path, tail=60, greps=("error", "fail", "✗", "×", "Unable", "ECONNREFUSED", "timeout", "Timeout")):
    try:
        lines = open(path, errors="replace").read().splitlines()
    except OSError:
        print(f"  (log {path} missing)")
        return
    print(f"  --- log tail ({len(lines)} lines total) ---")
    for ln in lines[-tail:]:
        print("  |", ln[:240])
    hits = [ln for ln in lines if any(g.lower() in ln.lower() for g in greps)]
    print(f"  --- {len(hits)} grep hits (first 25) ---")
    for ln in hits[:25]:
        print("  >", ln[:240])


def main():
    # run 16 = last completed failure, run 17 = currently in progress
    runs = [(41264564148, "run#16 latest-failure"), (41265409641, "run#17 current")]
    for run_id, label in runs:
        try:
            failed = print_jobs(run_id, label)
        except Exception as e:
            print(f"run {run_id}: probe error: {e}")
            continue
        for j in failed:
            path = f"/tmp/job-{j['id']}.log"
            n = fetch_log(j["id"], path)
            print(f"  >>> log for failed job {j['id']} ({j['name']}): {n} bytes -> {path}")
            if isinstance(n, int):
                summarize_log(path)


if __name__ == "__main__":
    sys.exit(main())
