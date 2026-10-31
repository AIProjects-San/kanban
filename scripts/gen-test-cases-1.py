#!/usr/bin/env python3
"""
Fernly — QA Test Case Catalog Generator
Produces an ADO-ready Excel workbook with ~250 test cases across 15 epics.

ADO fields mapped:
  ID | Epic | Feature Area | Title | Type | Priority | Severity | Automation Status
  | Precondition | Steps | Expected | Test Data | Tags | Linked Requirement
"""

import sys, os
XLSX_SKILL_DIR = "/home/z/my-project/skills/xlsx"
for sub in [XLSX_SKILL_DIR, os.path.join(XLSX_SKILL_DIR, "templates")]:
    if sub not in sys.path:
        sys.path.insert(0, sub)

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
from datetime import datetime

# ---------------------------------------------------------------------------
# Test case definitions
# ---------------------------------------------------------------------------

CASES = []

def tc(epic, area, title, ctype, priority, severity, auto, precond, steps, expected, data="", tags="", req=""):
    """Add a test case. ctype: Functional|Security|Performance|E2E|Integration|Smoke|Regression|Negative|Accessibility"""
    CASES.append({
        "ID": f"TC-{len(CASES)+1:04d}",
        "Epic": epic,
        "Feature Area": area,
        "Title": title,
        "Type": ctype,
        "Priority": priority,
        "Severity": severity,
        "Automation Status": auto,
        "Precondition": precond,
        "Steps": steps,
        "Expected": expected,
        "Test Data": data,
        "Tags": tags,
        "Linked Requirement": req,
    })

# ===========================================================================
# EPIC 1: Authentication & Session Management
# ===========================================================================

E = "E1-Auth"

tc(E,"Login","Successful sign-in with valid credentials","Functional","P0","Critical","Automated",
   "User exists in DB with known password; app running",
   "1. Navigate to / 2. Enter valid email + password 3. Click Sign In",
   "User redirected to dashboard; session cookie set; auth.signed_in audit row written with IP + UA",
   "demo@fernly.app / fernly123","smoke,login","REQ-AUTH-001")

tc(E,"Login","Sign-in fails with wrong password","Functional","P0","Critical","Automated",
   "User exists",
   "1. Enter valid email + wrong password 2. Submit",
   "Error shown; no session; failed attempt counts toward rate limit",
   "","login","REQ-AUTH-001")

tc(E,"Login","Sign-in fails for unknown email","Functional","P0","Critical","Automated",
   "Email not registered",
   "1. Enter unknown email + any password 2. Submit",
   "Same error as wrong password (anti-enumeration); bcrypt dummy compare runs (timing parity)",
   "","security,login","REQ-AUTH-002")

tc(E,"Login","Empty credentials rejected","Functional","P1","Major","Automated",
   "App running",
   "1. Leave email + password blank 2. Submit",
   "Returns null immediately; no DB hit; no rate-limit bucket touched",
   "","login","REQ-AUTH-001")

tc(E,"Login","Email with whitespace trimmed","Functional","P1","Major","Automated",
   "User exists with email ada@fernly.dev",
   "1. Enter '  ada@fernly.dev  ' (leading/trailing spaces) + correct password 2. Submit",
   "Email trimmed + lowercased before lookup; sign-in succeeds",
   "","edge-case,login","REQ-AUTH-001")

tc(E,"Login","Email case-insensitive","Functional","P1","Major","Automated",
   "User exists with email ada@fernly.dev",
   "1. Enter 'Ada@Fernly.DEV' + correct password 2. Submit",
   "Email lowercased; sign-in succeeds",
   "","login","REQ-AUTH-001")

tc(E,"Login","Brute-force lockout after 5 failed attempts","Security","P0","Critical","Automated",
   "User exists",
   "1. Submit wrong password 5 times for same email 2. Submit correct password",
   "6th attempt blocked by rate limiter; returns null; user locked for 15 min",
   "","security,rate-limit,e2e","REQ-AUTH-003")

tc(E,"Login","IP-based throttle blocks across emails","Security","P0","Critical","Manual",
   "Attacker on single IP",
   "1. Submit 5 different emails with wrong passwords from same IP 2. Submit 6th",
   "IP bucket trips; all further attempts from that IP blocked for 15 min",
   "","security,rate-limit","REQ-AUTH-003")

tc(E,"Login","X-Forwarded-For spoofing does not bypass IP throttle","Security","P1","Critical","Automated",
   "App behind nginx with X-Real-IP set",
   "1. Send 5 requests with spoofed X-Forwarded-For: 1.2.3.4 2. Send 6th from same real IP",
   "X-Real-IP preferred over XFF; real IP bucket trips; 6th blocked",
   "","security,edge-case,rate-limit","REQ-AUTH-003")

tc(E,"Login","Successful sign-in clears email rate-limit bucket","Functional","P1","Major","Automated",
   "User has 4 failed attempts",
   "1. Submit correct password",
   "Email bucket reset to 0; next typo starts fresh",
   "","rate-limit","REQ-AUTH-003")

tc(E,"Session","Session expires after 7 days","Security","P1","Major","Manual",
   "User signed in 7 days ago",
   "1. Wait 7 days 2. Navigate to app",
   "Session invalid; redirected to login",
   "","security,session","REQ-AUTH-004")

tc(E,"Session","Role change invalidates existing session within 5 min","Security","P0","Critical","Automated",
   "User signed in as MEMBER; admin changes their role to MANAGER",
   "1. Wait ≤5 min (ROLE_REFRESH_MS) 2. User navigates",
   "JWT callback detects tokenVersion mismatch; session cleared; user redirected to login",
   "","security,session","REQ-AUTH-005")

tc(E,"Session","Password change invalidates all other sessions","Security","P0","Critical","Automated",
   "User signed in on 2 devices",
   "1. Change password on device A 2. Navigate on device B within 5 min",
   "Device B session cleared (tokenVersion bump); user must re-authenticate",
   "","security,session","REQ-AUTH-005")

tc(E,"Session","Sign out all devices","Security","P1","Major","Automated",
   "User signed in on 2 devices",
   "1. Settings → Security → Sign out all devices 2. Confirm 3. Wait on device B",
   "tokenVersion bumped on both devices; both sessions cleared within 5 min; pending reset tokens invalidated",
   "","security,session,edge-case","REQ-AUTH-006")

tc(E,"Session","Soft-deleted user cannot sign in","Security","P0","Critical","Automated",
   "User soft-deleted via deleteUser",
   "1. Attempt sign-in with deleted user's credentials",
   "findUnique filters deletedAt:null; returns null; same UX as wrong password",
   "","security,soft-delete","REQ-AUTH-007")

tc(E,"Session","Soft-deleted user's existing session invalidated","Security","P0","Critical","Automated",
   "User signed in; then soft-deleted by admin",
   "1. Wait ≤5 min 2. User navigates",
   "JWT callback's deletedAt:null filter returns null; session cleared",
   "","security,soft-delete,session","REQ-AUTH-007")

tc(E,"Session","DB outage during sign-in returns null (not 500)","Functional","P1","Major","Automated",
   "DB temporarily down",
   "1. Attempt sign-in",
   "authorize catches DB error; returns null; no Prisma stack trace; structured log emitted",
   "","edge-case,resilience","REQ-AUTH-008")

tc(E,"Session","Corrupted passwordHash returns null (not 500)","Functional","P1","Major","Automated",
   "User row has malformed passwordHash",
   "1. Attempt sign-in with correct password",
   "bcrypt.compare throws; caught; returns null; failed attempt counts toward rate limit",
   "","edge-case,resilience","REQ-AUTH-008")

tc(E,"Session","NEXTAUTH_SECRET rotation self-heals stale cookies","Security","P1","Major","Automated",
   "NEXTAUTH_SECRET rotated; user has stale session cookie",
   "1. User navigates to app",
   "Proxy detects invalid cookie; strips it; expires session+CSRF+callback-url cookies; user sees login",
   "","security,session","REQ-AUTH-009")

tc(E,"Sign-out","Sign-out clears all auth cookies","Functional","P0","Critical","Automated",
   "User signed in",
   "1. Click Sign Out",
   "All 6 cookie namespaces (next-auth.session/csrf/callback-url + __Secure- variants) expired; user redirected to /",
   "","session,e2e","REQ-AUTH-010")

# Password Reset
tc(E,"Password Reset","Request reset for existing user sends email","Functional","P0","Critical","Automated",
   "User exists; RESEND_API_KEY set",
   "1. POST /reset-password with user's email",
   "Token created (SHA-256 hashed); email sent; {sent:true} returned; prior unused tokens invalidated",
   "","password-reset","REQ-AUTH-011")

tc(E,"Password Reset","Request reset for unknown email returns sent:true (anti-enumeration)","Security","P0","Critical","Automated",
   "Email not registered",
   "1. POST /reset-password with unknown email",
   "Returns {sent:true}; no DB write; no email sent; same response shape as existing user",
   "","security,password-reset","REQ-AUTH-012")

tc(E,"Password Reset","Reset token is single-use","Security","P0","Critical","Automated",
   "Valid unused token exists",
   "1. POST /reset-password/confirm with token + new password 2. POST again with same token",
   "First call succeeds; second call rejected with 'already used'",
   "","security,password-reset","REQ-AUTH-013")

tc(E,"Password Reset","Reset token expires after 1 hour","Functional","P0","Critical","Automated",
   "Token created 61 min ago",
   "1. Attempt reset with expired token",
   "Rejected with 'expired'; token must be re-requested",
   "","password-reset","REQ-AUTH-013")

tc(E,"Password Reset","Concurrent reset requests create only one valid token","Security","P1","Major","Automated",
   "User exists",
   "1. POST /reset-password twice simultaneously for same email",
   "$transaction wraps invalidate+create; only one valid token exists",
   "","security,edge-case,password-reset","REQ-AUTH-011")

tc(E,"Password Reset","Concurrent reset consumption race-safe","Security","P1","Major","Automated",
   "Valid token exists",
   "1. POST /reset-password/confirm twice simultaneously with same token + different passwords",
   "Conditional updateMany (WHERE usedAt IS NULL); second call rejected with 'just used'",
   "","security,edge-case,password-reset","REQ-AUTH-013")

tc(E,"Password Reset","changePassword invalidates pending reset tokens","Security","P1","Critical","Automated",
   "User has pending reset token (unused, unexpired)",
   "1. Change password via Settings 2. Attempt reset with old token",
   "Token invalidated in same $transaction as password change; reset attempt rejected",
   "","security,edge-case,password-reset","REQ-AUTH-013")

tc(E,"Password Reset","Reset email HTML-escapes user display name","Security","P1","Major","Automated",
   "User with name '<script>alert(1)</script>'",
   "1. Request reset",
   "Email body HTML-escapes the name; no script execution in email client",
   "","security,xss,password-reset","REQ-AUTH-011")

tc(E,"Password Reset","Reset rate-limited per email (5/hr) and per IP (20/hr)","Security","P0","Critical","Automated",
   "User exists",
   "1. Request reset 6 times in 1 hour for same email",
   "6th request throttled; returns {sent:true} without touching DB (anti-enumeration preserved)",
   "","security,rate-limit,password-reset","REQ-AUTH-003")

tc(E,"Password Reset","NoopMailer logs structured warning in production","Functional","P1","Major","Automated",
   "RESEND_API_KEY unset; NODE_ENV=production",
   "1. Request reset",
   "Structured [password-reset] DEGRADED warning logged; token still written; {sent:true} returned",
   "","resilience,password-reset","REQ-AUTH-011")

tc(E,"Password Reset","New password below workspace min length rejected","Functional","P1","Major","Automated",
   "Workspace minPasswordLength=8",
   "1. Attempt reset with 6-char new password",
   "Rejected with 'at least 8 characters'",
   "","password-reset,validation","REQ-AUTH-013")

tc(E,"Password Reset","New password above 1024 chars rejected","Functional","P2","Minor","Automated",
   "",
   "1. Attempt reset with 1MB new password",
   "Rejected with 'at most 1024 characters' (bcrypt 72-byte truncation + memory DoS guard)",
   "","edge-case,validation,password-reset","REQ-AUTH-013")

print(f"Epic 1 (Auth): {len(CASES)} cases so far")

# ===========================================================================
# EPIC 2: RBAC & Authorization
# ===========================================================================

E = "E2-RBAC"

tc(E,"Permission Gates","MEMBER can create tasks (task:create)","Functional","P0","Critical","Automated",
   "Signed in as MEMBER",
   "1. Call createTask",
   "Task created; audit logged",
   "","rbac","REQ-RBAC-001")

tc(E,"Permission Gates","MEMBER cannot delete tasks (task:delete denied)","Security","P0","Critical","Automated",
   "Signed in as MEMBER",
   "1. Call deleteTask",
   "AuthorizationError thrown; no DB write",
   "","security,rbac","REQ-RBAC-002")

tc(E,"Permission Gates","MEMBER cannot create projects","Security","P0","Critical","Automated",
   "Signed in as MEMBER",
   "1. Call createProject",
   "AuthorizationError",
   "","security,rbac","REQ-RBAC-002")

tc(E,"Permission Gates","MANAGER can create projects but not delete them","Functional","P0","Critical","Automated",
   "Signed in as MANAGER",
   "1. createProject 2. deleteProject",
   "Create succeeds; delete throws AuthorizationError",
   "","rbac,e2e","REQ-RBAC-003")

tc(E,"Permission Gates","ADMIN can perform all operations","Functional","P0","Critical","Automated",
   "Signed in as ADMIN",
   "1. Exercise every server action",
   "All succeed (subject to self-protection rules)",
   "","rbac","REQ-RBAC-004")

tc(E,"Permission Gates","MANAGER cannot access role:manage operations","Security","P0","Critical","Automated",
   "Signed in as MANAGER",
   "1. Call createUser 2. Call updateWorkspaceSettings 3. Call pruneAuditLogs",
   "All throw AuthorizationError",
   "","security,rbac","REQ-RBAC-005")

tc(E,"Permission Gates","Unauthenticated requests rejected","Security","P0","Critical","Automated",
   "Not signed in",
   "1. Call any server action",
   "getSession returns null; AuthorizationError 'must be signed in'",
   "","security,rbac","REQ-RBAC-006")

tc(E,"DB Ceiling","DB-granted permission extends static floor","Functional","P1","Major","Manual",
   "Admin grants role:manage to MANAGER role via DB",
   "1. Sign in as MANAGER 2. Call createUser",
   "hasPermissionDb checks DB ceiling; MANAGER can now create users (within subtree)",
   "","rbac,db-ceiling","REQ-RBAC-007")

tc(E,"DB Ceiling","DB failure falls back to static-only (deny-by-default)","Security","P1","Critical","Automated",
   "DB down; MANAGER has DB-granted role:manage",
   "1. Call createUser",
   "hasPermissionDb catches DB error; falls back to static floor; AuthorizationError",
   "","security,rbac,resilience","REQ-RBAC-007")

tc(E,"Hierarchy","MANAGER can manage users in their subtree","Functional","P0","Critical","Automated",
   "MANAGER M has reports A, B (direct) and C (indirect via A)",
   "1. M calls updateUser(A.id, {bio:'new'})",
   "Succeeds; canManageUser returns true for subtree members",
   "","rbac,hierarchy","REQ-RBAC-008")

tc(E,"Hierarchy","MANAGER cannot manage users outside their subtree","Security","P0","Critical","Automated",
   "MANAGER M; user X is in another MANAGER's subtree",
   "1. M calls updateUser(X.id, {...})",
   "AuthorizationError; canManageUser returns false",
   "","security,rbac,hierarchy","REQ-RBAC-008")

tc(E,"Hierarchy","ADMIN bypasses hierarchy check","Functional","P1","Major","Automated",
   "ADMIN; target user in any subtree",
   "1. ADMIN calls updateUser on any user",
   "Succeeds; admin short-circuits canManageUser",
   "","rbac,hierarchy","REQ-RBAC-004")

tc(E,"Hierarchy","Self-management passes hierarchy (self-protection in caller)","Functional","P1","Major","Automated",
   "MANAGER M",
   "1. M calls updateUser(M.id, {bio:'new'}) (not role/managerId)",
   "Succeeds; self-management allowed; self-protection rules enforce no role/manager self-change",
   "","rbac,hierarchy","REQ-RBAC-008")

tc(E,"Hierarchy","Cycle detection prevents manager cycle","Security","P1","Critical","Automated",
   "User A manages B; B manages C",
   "1. Attempt to set C as A's manager",
   "assertNoCycle throws 'would create a cycle'",
   "","security,rbac,hierarchy","REQ-RBAC-009")

tc(E,"Hierarchy","Self-reference as manager rejected","Security","P1","Major","Automated",
   "User A",
   "1. Set A.managerId = A.id",
   "assertNoCycle throws 'cannot be their own manager'",
   "","security,rbac,hierarchy","REQ-RBAC-009")

tc(E,"Privilege Escalation","Non-admin cannot grant ADMIN role via createUser","Security","P0","Critical","Automated",
   "MANAGER with role:manage (DB-granted)",
   "1. createUser({role:'ADMIN'})",
   "AuthorizationError 'Only an admin can grant the ADMIN role'",
   "","security,rbac,escalation","REQ-RBAC-010")

tc(E,"Privilege Escalation","Non-admin cannot grant ADMIN role via updateUser","Security","P0","Critical","Automated",
   "MANAGER with role:manage",
   "1. updateUser(target, {role:'ADMIN'})",
   "AuthorizationError (F-14 guard)",
   "","security,rbac,escalation","REQ-RBAC-010")

tc(E,"Privilege Escalation","Non-admin cannot grant role:manage permission","Security","P0","Critical","Automated",
   "MANAGER with role:manage",
   "1. updateRole(someRole, {permissions:['role:manage']})",
   "AuthorizationError 'Only ADMIN may grant: role:manage'",
   "","security,rbac,escalation","REQ-RBAC-010")

tc(E,"Privilege Escalation","updateProfile schema has no role field","Security","P1","Critical","Automated",
   "Signed in as MEMBER",
   "1. updateProfile({role:'ADMIN'})",
   "Schema rejects unknown field; role unchanged",
   "","security,rbac,escalation","REQ-RBAC-010")

tc(E,"Privilege Escalation","Self-demotion prevented","Security","P1","Major","Automated",
   "ADMIN managing self",
   "1. updateUser(self, {role:'MEMBER'})",
   "AuthorizationError 'cannot change your own role'",
   "","security,rbac","REQ-RBAC-010")

tc(E,"Privilege Escalation","Self-delete prevented","Security","P1","Major","Automated",
   "ADMIN",
   "1. deleteUser(self.id)",
   "AuthorizationError 'cannot delete your own account'",
   "","security,rbac","REQ-RBAC-010")

tc(E,"Privilege Escalation","Self-manager change prevented (non-admin)","Security","P1","Major","Automated",
   "MANAGER",
   "1. updateUser(self, {managerId: other})",
   "AuthorizationError 'cannot change your own manager'",
   "","security,rbac","REQ-RBAC-010")

tc(E,"Soft-delete targeting","Soft-deleted user cannot be targeted by updateUser","Security","P1","Critical","Automated",
   "User soft-deleted",
   "1. Admin calls updateUser(deletedUser.id, {role:'ADMIN'})",
   "findUnique filters deletedAt:null; 'User not found'",
   "","security,rbac,soft-delete,edge-case","REQ-RBAC-011")

tc(E,"Soft-delete targeting","Soft-deleted user cannot be targeted by deleteUser","Security","P1","Major","Automated",
   "User already soft-deleted",
   "1. Admin calls deleteUser(deletedUser.id)",
   "'User not found' (idempotent)",
   "","security,rbac,soft-delete,edge-case","REQ-RBAC-011")

print(f"Epic 2 (RBAC): {len(CASES)} cases so far")

# ===========================================================================
# EPIC 3: Task Management
# ===========================================================================

E = "E3-Tasks"

tc(E,"Create Task","Create task with minimum required fields","Functional","P0","Critical","Automated",
   "Signed in; project exists",
   "1. createTask({title:'Test', projectId:'p1'})",
   "Task created with status=TODO, priority=MEDIUM, tag=FRONTEND; audit task.created; assignee workload recalced",
   "","smoke,tasks,e2e","REQ-TASK-001")

tc(E,"Create Task","Create task with all fields","Functional","P1","Major","Automated",
   "Signed in",
   "1. createTask with title, description, status, priority, tag, dueDate, projectId, assigneeId",
   "All fields persisted; audit includes project name",
   "","tasks","REQ-TASK-001")

tc(E,"Create Task","Empty title rejected","Functional","P1","Major","Automated",
   "",
   "1. createTask({title:''})",
   "Zod validation error",
   "","validation,tasks","REQ-TASK-001")

tc(E,"Create Task","Title > 200 chars rejected","Functional","P2","Minor","Automated",
   "",
   "1. createTask({title: 'x'.repeat(201)})",
   "Zod validation error",
   "","validation,tasks","REQ-TASK-001")

tc(E,"Create Task","MEMBER can only create tasks in scoped projects","Security","P1","Critical","Automated",
   "MEMBER; project B not in their scope",
   "1. createTask({projectId: B})",
   "AuthorizationError 'only create tasks in projects you have access to'",
   "","security,tasks,rbac,edge-case","REQ-TASK-002")

tc(E,"Create Task","Description with @mention triggers notification","Functional","P1","Major","Automated",
   "User 'Ada' exists",
   "1. createTask({description:'@Ada please review'})",
   "MENTION notification created for Ada; Ada excluded if opt-out; actor not notified",
   "","tasks,mentions","REQ-TASK-003")

tc(E,"Create Task","Mention scope limited to name-matching users","Security","P2","Minor","Automated",
   "10k users in workspace",
   "1. createTask with @mention",
   "User query scoped to mention-token ILIKE + take:500; not all users loaded",
   "","security,performance,mentions,edge-case","REQ-TASK-003")

tc(E,"Update Task","Update task title","Functional","P0","Critical","Automated",
   "Task exists; caller has edit rights",
   "1. updateTask(id, {title:'New'})",
   "Title updated; audit task.updated with 'title' in diff",
   "","tasks","REQ-TASK-004")

tc(E,"Update Task","MEMBER can only edit tasks assigned to them","Security","P0","Critical","Automated",
   "MEMBER; task assigned to another",
   "1. updateTask(otherTaskId, {...})",
   "assertTaskEditPermission throws",
   "","security,tasks,rbac","REQ-TASK-004")

tc(E,"Update Task","ADMIN can edit any task","Functional","P1","Major","Automated",
   "ADMIN; task assigned to anyone",
   "1. updateTask(anyTaskId, {...})",
   "Succeeds (task:edit:any)",
   "","tasks,rbac","REQ-TASK-004")

tc(E,"Update Task","Move task to project outside scope rejected","Security","P1","Major","Automated",
   "MEMBER; task in scoped project A",
   "1. updateTask(taskId, {projectId: unscopedB})",
   "AuthorizationError 'only move tasks to projects you have access to'",
   "","security,tasks,edge-case","REQ-TASK-004")

tc(E,"Update Task","Description change re-fires mention notifications","Functional","P1","Major","Automated",
   "Task exists with description",
   "1. updateTask(id, {description:'@Bob new work'})",
   "Notification for Bob; not fired if description unchanged",
   "","tasks,mentions","REQ-TASK-003")

tc(E,"Update Task","Not-found task is silent no-op","Functional","P2","Minor","Automated",
   "",
   "1. updateTask('nonexistent-id', {...})",
   "Returns void; no error; no audit (F-15)",
   "","tasks","REQ-TASK-004")

tc(E,"Move Task","Move task to new status (Kanban DnD)","Functional","P0","Critical","Automated",
   "Task in TODO",
   "1. moveTask(id, 'IN_PROGRESS', 0)",
   "Status + order updated; audit task.moved",
   "","tasks,e2e","REQ-TASK-005")

tc(E,"Move Task","Reorder within same status does not audit move","Functional","P2","Minor","Automated",
   "Task in TODO at order 0",
   "1. moveTask(id, 'TODO', 5)",
   "Order updated; no task.moved audit (status unchanged)",
   "","tasks","REQ-TASK-005")

tc(E,"Move Task","Invalid status string rejected","Functional","P1","Major","Automated",
   "",
   "1. moveTask(id, 'INVALID', 0)",
   "Zod error",
   "","validation,tasks","REQ-TASK-005")

tc(E,"Delete Task","Delete task by owner","Functional","P0","Critical","Automated",
   "ADMIN; task exists",
   "1. deleteTask(id)",
   "Task hard-deleted; assignee workload recalced; audit task.deleted",
   "","tasks","REQ-TASK-006")

tc(E,"Delete Task","MEMBER cannot delete task","Security","P1","Major","Automated",
   "MEMBER",
   "1. deleteTask(id)",
   "AuthorizationError (task:delete denied)",
   "","security,tasks,rbac","REQ-TASK-006")

tc(E,"Bulk Update","Bulk update status on 10 tasks","Functional","P0","Critical","Automated",
   "ADMIN; 10 tasks exist",
   "1. bulkUpdateTasks([10 ids], {status:'DONE'})",
   "All 10 updated atomically via updateMany; audit with updated:10, skipped:0",
   "","tasks,bulk","REQ-TASK-007")

tc(E,"Bulk Update","Bulk update skips tasks caller cannot edit","Functional","P1","Major","Automated",
   "MEMBER; 10 tasks, 5 assigned to others",
   "1. bulkUpdateTasks([10 ids], {status:'DONE'})",
   "5 updated, 5 skipped for permissions; audit reflects counts",
   "","tasks,bulk,rbac","REQ-TASK-007")

tc(E,"Bulk Update","Bulk update >100 tasks rejected","Functional","P1","Major","Automated",
   "",
   "1. bulkUpdateTasks([101 ids], {...})",
   "AuthorizationError (MAX_BULK=100)",
   "","tasks,bulk,validation","REQ-TASK-007")

tc(E,"Bulk Update","Bulk update with empty patch rejected","Functional","P2","Minor","Automated",
   "",
   "1. bulkUpdateTasks([ids], {})",
   "AuthorizationError 'Nothing to update'",
   "","tasks,bulk,validation","REQ-TASK-007")

tc(E,"Bulk Update","Bulk update is atomic (transaction)","Security","P1","Major","Automated",
   "5 tasks to update",
   "1. bulkUpdateTasks 2. Simulate DB failure mid-update",
   "$transaction wraps updateMany; either all move or none do",
   "","security,tasks,bulk,edge-case","REQ-TASK-007")

tc(E,"Bulk Update","Bulk update non-existent assigneeId gives friendly error","Functional","P2","Minor","Manual",
   "",
   "1. bulkUpdateTasks([ids], {assigneeId:'nonexistent'})",
   "FK violation caught; user-friendly error (not raw Prisma P2003)",
   "","tasks,bulk,edge-case","REQ-TASK-007")

print(f"Epic 3 (Tasks): {len(CASES)} cases so far")

# ===========================================================================
# EPIC 4: Project Management
# ===========================================================================

E = "E4-Projects"

tc(E,"Create Project","Create project with valid fields","Functional","P0","Critical","Automated",
   "Signed in as MANAGER+",
   "1. createProject({name:'New Proj', ownerMemberId:'m1'})",
   "Project created; ownerName/ownerUserId derived from roster; audit project.created",
   "","projects","REQ-PROJ-001")

tc(E,"Create Project","Soft-deleted TeamMember not assignable as owner","Security","P1","Major","Automated",
   "TeamMember soft-deleted",
   "1. createProject({ownerMemberId: deletedMemberId})",
   "findUnique filters deletedAt:null; 'not a team member'",
   "","security,projects,soft-delete,edge-case","REQ-PROJ-001")

tc(E,"Update Project","Update project name + progress","Functional","P0","Critical","Automated",
   "Project exists",
   "1. updateProject(id, {name:'Updated', progress:50})",
   "Fields updated; audit project.updated with diff",
   "","projects","REQ-PROJ-002")

tc(E,"Update Project","Progress clamped to 0-100","Functional","P1","Major","Automated",
   "",
   "1. updateProject(id, {progress:150})",
   "Zod error (max 100)",
   "","validation,projects","REQ-PROJ-002")

tc(E,"Update Project","Soft-deleted member not assignable as new owner","Security","P1","Major","Automated",
   "Project exists; member soft-deleted",
   "1. updateProject(id, {ownerMemberId: deletedId})",
   "filtered out; 'not a team member'",
   "","security,projects,edge-case","REQ-PROJ-002")

tc(E,"Delete Project","Soft-delete project preserves task references","Functional","P0","Critical","Automated",
   "Project with 5 tasks",
   "1. deleteProject(id)",
   "Project.deletedAt set; tasks preserved (orphaned but restorable); audit project.deleted",
   "","projects,soft-delete","REQ-PROJ-003")

tc(E,"Delete Project","MEMBER cannot delete project","Security","P0","Critical","Automated",
   "MEMBER",
   "1. deleteProject(id)",
   "AuthorizationError (project:delete denied)",
   "","security,projects,rbac","REQ-PROJ-003")

tc(E,"Restore Project","Restore soft-deleted project","Functional","P1","Major","Automated",
   "Project in trash",
   "1. restoreProject(id)",
   "deletedAt cleared; audit project.restored; tasks visible again",
   "","projects,trash","REQ-PROJ-004")

tc(E,"Restore Project","Restore already-live project rejected","Functional","P2","Minor","Automated",
   "Project.deletedAt is null",
   "1. restoreProject(id)",
   "AuthorizationError 'not in the trash'",
   "","projects,trash","REQ-PROJ-004")

tc(E,"Project Scoping","MEMBER dashboard only shows scoped projects","Functional","P0","Critical","Automated",
   "MEMBER; owns A, assigned to B, not C",
   "1. getDashboardData",
   "Returns A + B only; C excluded (getScopedProjectIds filter)",
   "","projects,rbac,scoping","REQ-PROJ-005")

tc(E,"Project Scoping","MEMBER cannot read tasks in unscoped project","Security","P1","Critical","Automated",
   "MEMBER; project C not in scope",
   "1. getTasksPage({projectId: C})",
   "Empty result (scoped where clause)",
   "","security,projects,rbac,scoping","REQ-PROJ-005")

tc(E,"Project Assignment","Assign user to project","Functional","P1","Major","Automated",
   "ADMIN; user + project exist",
   "1. assignUserToProject(userId, projectId)",
   "ProjectAssignment upserted; audit project.assigned",
   "","projects,assignments","REQ-PROJ-006")

tc(E,"Project Assignment","Unassign user from project","Functional","P1","Major","Automated",
   "Assignment exists",
   "1. unassignUserFromProject(userId, projectId)",
   "Assignment deleted; audit project.unassigned",
   "","projects,assignments","REQ-PROJ-006")

tc(E,"Project Assignment","Duplicate assignment is idempotent","Functional","P2","Minor","Automated",
   "Assignment already exists",
   "1. assignUserToProject (same user+project)",
   "Upsert; no duplicate; no error",
   "","projects,assignments","REQ-PROJ-006")

print(f"Epic 4 (Projects): {len(CASES)} cases so far")

# ===========================================================================
# EPIC 5: Team & User Management
# ===========================================================================

E = "E5-Team"

tc(E,"Create User","Admin creates MEMBER user","Functional","P0","Critical","Automated",
   "ADMIN",
   "1. createUser({name,email,password,role:'MEMBER'})",
   "User + TeamMember created in $transaction; audit user.created",
   "","users","REQ-USER-001")

tc(E,"Create User","Duplicate email rejected","Functional","P0","Critical","Automated",
   "Email already registered",
   "1. createUser with existing email",
   "AuthorizationError 'already exists'",
   "","users,validation","REQ-USER-001")

tc(E,"Create User","Password below min length rejected","Functional","P1","Major","Automated",
   "Workspace min=8",
   "1. createUser({password:'short'})",
   "AuthorizationError 'at least 8 characters'",
   "","users,validation","REQ-USER-001")

tc(E,"Create User","Password above 1024 chars rejected","Functional","P2","Minor","Automated",
   "",
   "1. createUser with 1MB password",
   "AuthorizationError 'at most 1024 characters'",
   "","users,validation,edge-case","REQ-USER-001")

tc(E,"Create User","Invalid role rejected","Functional","P1","Major","Automated",
   "",
   "1. createUser({role:'SUPERADMIN'})",
   "AuthorizationError 'Invalid role'",
   "","users,validation","REQ-USER-001")

tc(E,"Create User","Manager assigned via managerId","Functional","P2","Minor","Automated",
   "Manager exists",
   "1. createUser({managerId: mgrId})",
   "User.managerId set; assertNoCycle passes",
   "","users,hierarchy","REQ-USER-001")

tc(E,"Update User","Update user email","Functional","P0","Critical","Automated",
   "ADMIN; target user exists",
   "1. updateUser(id, {email:'new@x.co'})",
   "Email updated; uniqueness pre-checked; roster row synced; audit user.updated",
   "","users","REQ-USER-002")

tc(E,"Update User","Duplicate email on update rejected","Functional","P1","Major","Automated",
   "Another user has 'taken@x.co'",
   "1. updateUser(id, {email:'taken@x.co'})",
   "AuthorizationError 'already exists' (pre-check, not P2002)",
   "","users,validation,edge-case","REQ-USER-002")

tc(E,"Update User","Soft-deleted manager not assignable","Security","P1","Major","Automated",
   "Manager soft-deleted",
   "1. updateUser(id, {managerId: deletedMgrId})",
   "findUnique filters deletedAt:null; 'does not exist'",
   "","security,users,soft-delete,edge-case","REQ-USER-002")

tc(E,"Update User","Role change bumps tokenVersion","Security","P0","Critical","Automated",
   "Target user signed in elsewhere",
   "1. updateUser(id, {role:'MANAGER'})",
   "tokenVersion incremented; target's session invalidated within 5 min",
   "","security,users,session","REQ-USER-002")

tc(E,"Update User","Password reset by admin bumps tokenVersion","Security","P0","Critical","Automated",
   "ADMIN resets target's password",
   "1. updateUser(id, {resetPassword:'newpass'})",
   "passwordHash updated; tokenVersion bumped; target signed out",
   "","security,users,session","REQ-USER-002")

tc(E,"Delete User","Soft-delete user preserves references","Functional","P0","Critical","Automated",
   "User has messages, tasks, projects",
   "1. deleteUser(id)",
   "User + linked TeamMember soft-deleted atomically; messages/tasks preserved; audit user.deleted",
   "","users,soft-delete","REQ-USER-003")

tc(E,"Delete User","Cannot delete self","Security","P1","Major","Automated",
   "ADMIN",
   "1. deleteUser(self.id)",
   "AuthorizationError 'cannot delete your own account'",
   "","security,users","REQ-USER-003")

tc(E,"Delete User","Soft-deleted user's email cannot be reused while soft-deleted","Functional","P1","Major","Automated",
   "User soft-deleted with email 'a@x.co'",
   "1. createUser({email:'a@x.co'})",
   "Rejected (unique constraint on email includes soft-deleted rows)",
   "","users,soft-delete","REQ-USER-003")

tc(E,"Restore User","Restore soft-deleted user","Functional","P1","Major","Automated",
   "User in trash",
   "1. restoreUser(id)",
   "User + TeamMember deletedAt cleared; audit user.restored; user can sign in again",
   "","users,trash","REQ-USER-004")

tc(E,"Restore User","Cannot restore self","Security","P2","Minor","Automated",
   "",
   "1. restoreUser(self.id) (if soft-deleted — edge)",
   "AuthorizationError 'cannot restore yourself'",
   "","security,users,trash","REQ-USER-004")

tc(E,"Team Members","Create team member","Functional","P1","Major","Automated",
   "MANAGER+",
   "1. createMember({name, email, role, department})",
   "TeamMember created; auto-linked to User by email (if exists + not deleted); audit member.invited",
   "","members","REQ-TEAM-001")

tc(E,"Team Members","Create member does not auto-link to soft-deleted user","Security","P1","Major","Automated",
   "Soft-deleted user with same email",
   "1. createMember({email: deletedUserEmail})",
   "findUnique filters deletedAt:null; no auto-link; member created without userId",
   "","security,members,soft-delete,edge-case","REQ-TEAM-001")

tc(E,"Team Members","Update member","Functional","P1","Major","Automated",
   "Member exists",
   "1. updateMember(id, {name:'New'})",
   "Updated; audit member.updated with diff",
   "","members","REQ-TEAM-001")

tc(E,"Team Members","Delete member (hard delete)","Functional","P1","Major","Automated",
   "ADMIN; member exists",
   "1. deleteMember(id)",
   "Hard-deleted; audit member.removed",
   "","members","REQ-TEAM-001")

tc(E,"Team Members","Workload recalculation after task change","Functional","P1","Major","Automated",
   "Member has 3 open tasks",
   "1. Mark 2 as DONE 2. recalcMemberStats runs",
   "openTasks=1, completedTasks=2, workload recalculated (min 100, capacity from Workspace)",
   "","members,workload","REQ-TEAM-002")

tc(E,"Team Members","Workload clamped to 100","Functional","P2","Minor","Automated",
   "Member has 20 open tasks; capacity=6",
   "1. recalcMemberStats",
   "workload=100 (Math.min clamp)",
   "","members,workload","REQ-TEAM-002")

tc(E,"Team Members","Workload capacity falls back to 6 when Workspace.workloadFullCapacity <= 0","Functional","P2","Minor","Automated",
   "Workspace.workloadFullCapacity=0",
   "1. recalcMemberStats",
   "Uses capacity=6 (guard against div-by-zero)",
   "","members,workload","REQ-TEAM-002")

print(f"Epic 5 (Team): {len(CASES)} cases so far")

# Save partial — we'll continue in next write
import json
with open("/tmp/fernly_test_cases_partial.json", "w") as f:
    json.dump(CASES, f, indent=2)
print(f"\n=== Partial save: {len(CASES)} cases ===")
