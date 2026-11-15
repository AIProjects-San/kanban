#!/usr/bin/env python3
"""Check E: for each 'internal helper' server action, find callers OUTSIDE
src/server-actions (components, pages, api routes). Classify:
  UI/page/api caller  -> user-facing (belongs in a flow)
  action-only callers -> stays internal
"""
import re, os, glob

ROOT = "/home/z/my-project"
HELPERS = {
    # file -> exports
    "auth-guard.ts": ["getSession", "checkPermission", "requirePermission", "getSessionOrThrow", "requirePermissionForTarget"],
    "shared.ts": ["fmtDayDate", "getWorkspaceLimit", "getMyTeamMemberId", "getScopedProjectIds", "visibleMemberWhere",
                  "getVisibleMemberIds", "getProjectAssociatedUserIds", "assertUserAssociatedWithProject",
                  "assertTeamMemberAssociatedWithProject", "assertTaskEditPermission", "assertTaskDeletePermission",
                  "recalcMemberStats", "readOnboardingTemplate", "instantiateChecklist"],
    "hr-shared.ts": ["workingDays", "getHolidayRows", "todayUTC", "getApproverIdsFor", "assertLeaveDecider", "windowArgFor",
                     "loadLeavePeriods", "getOrCreateBalance", "getOrCreateBalancesBatch", "ledgerProjectionFor",
                     "materializeLeaveBalanceTx", "findApprovedLeaveOn", "findOverlappingActiveRequest",
                     "deriveOnLeaveAttendance", "removeDerivedOnLeaveAttendance", "nextEmployeeNumber"],
    "result.ts": ["toResult", "isUniqueConstraintError"],
    "ics-export.ts": ["exportCalendarIcs"],
    "data-export.ts": ["exportMyData"],
    "mentions.ts": ["notifyMentionedUsers"],
    # previously-excluded singles (same logic applies)
    "search.ts": ["searchWorkspace"],
    "password-reset.ts": ["requestPasswordReset", "validateResetToken", "resetPassword"],
    "payday-filing.ts": ["refreshOverdueFilings"],
    "audit-retention.ts": ["pruneAuditLogs", "getAuditRetentionInfo"],
    "biometric.ts": ["matchPunchToEmployee"],  # internal matcher — sanity check
}

ui_callers, action_only = [], []
for fname, fns in HELPERS.items():
    for fn in fns:
        hits = []
        for path in glob.glob(os.path.join(ROOT, "src", "**", "*.ts*"), recursive=True):
            rel = os.path.relpath(path, ROOT)
            if "__tests__" in rel or rel.startswith("src/server-actions"):
                continue
            try:
                src = open(path).read()
            except Exception:
                continue
            # caller = imports the fn or invokes it (data barrel re-export)
            if re.search(r'\b' + fn + r'\b', src):
                kind = "api" if rel.startswith("src/app/api") else ("page" if rel.startswith("src/app") else "ui")
                hits.append(f"{kind}:{rel}")
        if hits:
            ui_callers.append((fn, fname, hits[:6]))
        else:
            action_only.append((fn, fname))

print("=== HAS CALLER OUTSIDE server-actions (candidate user-facing) ===")
for fn, fname, hits in ui_callers:
    kinds = sorted(set(h.split(":")[0] for h in hits))
    print(f"  {fn} ({fname})  [{'+'.join(kinds)}]")
    for h in hits:
        print(f"      {h}")
print()
print(f"=== ACTION-ONLY (stays internal): {len(action_only)} ===")
for fn, fname in action_only:
    print(f"  {fn} ({fname})")
print()
print(f"SUMMARY: {len(ui_callers)} with outside callers, {len(action_only)} internal")
