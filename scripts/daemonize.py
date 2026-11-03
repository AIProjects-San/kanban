#!/usr/bin/env python3
"""Double-fork daemonizer for the Fernly dev server.

Spawns a command fully detached (re-parented to PID 1, new session,
closed stdio inheritors) so it survives the end of the Bash tool
session that launched it. Mirrors the classic double-fork pattern.
"""
import os
import sys

if len(sys.argv) < 2:
    print("usage: daemonize.py <command> [args...]", file=sys.stderr)
    sys.exit(2)

command = sys.argv[1:]

# --- fork 1: parent exits immediately, child continues ---
pid = os.fork()
if pid > 0:
    print(f"[daemonize] fork-1 parent exiting (child={pid})")
    sys.exit(0)

# --- child: detach from controlling terminal ---
os.setsid()

# --- fork 2: ensure the daemon can never reacquire a terminal ---
pid = os.fork()
if pid > 0:
    sys.exit(0)

# --- grandchild: re-parented to PID 1, fully detached ---

# Reset file mode + redirect stdio to the dev log (the dev script's own
# tee also writes dev.log; this is a fallback for anything outside it).
os.umask(0o022)
log = open("/tmp/fernly-daemon.log", "ab", buffering=0)
os.dup2(log.fileno(), 0)  # stdin <- /dev/null-ish (log fd, never read)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)

os.chdir("/home/z/my-project")
os.execvp(command[0], command)
