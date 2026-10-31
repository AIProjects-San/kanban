#!/usr/bin/env python3
"""
Fernly QA Test Cases — Part 2: Epics 6-15 + Excel generation.
Loads the 117 cases from Part 1, appends 10 more epics, generates the workbook.
"""

import sys, os, json
from datetime import datetime
XLSX_SKILL_DIR = "/home/z/my-project/skills/xlsx"
for sub in [XLSX_SKILL_DIR, os.path.join(XLSX_SKILL_DIR, "templates")]:
    if sub not in sys.path:
        sys.path.insert(0, sub)

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# Load Part 1 cases
with open("/tmp/fernly_test_cases_partial.json") as f:
    CASES = json.load(f)

def tc(epic, area, title, ctype, priority, severity, auto, precond, steps, expected, data="", tags="", req=""):
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
# EPIC 6: Messaging & Notifications
# ===========================================================================

E = "E6-Messaging"

tc(E,"Send Message","Send message to another user","Functional","P0","Critical","Automated",
   "Signed in; recipient exists",
   "1. sendMessage({recipientId, subject, body})",
   "Message created with derived senderName/Avatar/Role; threadId generated; audit message.sent",
   "","messaging,e2e","REQ-MSG-001")

tc(E,"Send Message","Sender identity derived from session (not client)","Security","P0","Critical","Automated",
   "Signed in as Ada",
   "1. sendMessage({senderName:'Imposter', recipientId, ...})",
   "senderName/senderAvatarColor/senderRole derived from session+roster; client values ignored (F-08)",
   "","security,messaging","REQ-MSG-001")

tc(E,"Read State","Recipient sees message as unread","Functional","P0","Critical","Automated",
   "Recipient signed in; message sent to them",
   "1. getDashboardData 2. Check inbox",
   "Message appears with unread indicator; no MessageRead row for this user",
   "","messaging,e2e","REQ-MSG-002")

tc(E,"Read State","Mark message read","Functional","P0","Critical","Automated",
   "Recipient has unread message",
   "1. markMessageRead(id)",
   "MessageRead row upserted; message shows as read",
   "","messaging","REQ-MSG-002")

tc(E,"Read State","Mark thread read","Functional","P1","Major","Automated",
   "Recipient has 5 unread in thread",
   "1. markThreadRead(threadId)",
   "All 5 marked read via bulk insert",
   "","messaging","REQ-MSG-002")

tc(E,"Read State","Other users cannot mark someone else's message read","Security","P1","Major","Automated",
   "User A tries to mark user B's message",
   "1. markMessageRead(B's messageId)",
   "Silent no-op (recipient-only check); no MessageRead row created",
   "","security,messaging","REQ-MSG-002")

tc(E,"Read State","Read state is per-recipient","Functional","P1","Major","Automated",
   "2 recipients in same thread",
   "1. Recipient A marks read 2. Recipient B checks inbox",
   "A sees read; B still sees unread (per-recipient MessageRead rows)",
   "","messaging","REQ-MSG-002")

tc(E,"Delete Message","Sender soft-deletes message","Functional","P1","Major","Automated",
   "User sent a message",
   "1. deleteMessage(id)",
   "Message.deletedAt set; audit message.deleted; hidden from sender's view",
   "","messaging","REQ-MSG-003")

tc(E,"Delete Message","Recipient can soft-delete","Functional","P1","Major","Automated",
   "User received a message",
   "1. deleteMessage(id)",
   "Soft-deleted; hidden from recipient's view",
   "","messaging","REQ-MSG-003")

tc(E,"Delete Message","Non-participant cannot delete","Security","P1","Major","Automated",
   "User C (not sender/recipient)",
   "1. deleteMessage(id)",
   "AuthorizationError (sender-or-recipient ownership check)",
   "","security,messaging","REQ-MSG-003")

tc(E,"Restore Message","Restore soft-deleted message","Functional","P2","Minor","Automated",
   "Message in trash",
   "1. restoreMessage(id)",
   "deletedAt cleared; audit message.restored; visible again to sender+recipient",
   "","messaging,trash","REQ-MSG-003")

tc(E,"Notifications","Mention notification created","Functional","P0","Critical","Automated",
   "User @mentioned in task description",
   "1. createTask with @Name 2. Mentioned user checks notifications",
   "MENTION notification appears; title includes actor name",
   "","notifications,mentions","REQ-NOTIF-001")

tc(E,"Notifications","Mention respects opt-out toggle","Functional","P1","Major","Automated",
   "User has notifMentions=false",
   "1. @mention them",
   "No notification created (Settings toggle honoured)",
   "","notifications,mentions","REQ-NOTIF-001")

tc(E,"Notifications","Actor not notified of own mention","Functional","P1","Major","Automated",
   "User @mentions themselves",
   "1. createTask with @Self",
   "No self-notification (actor === mentioned user excluded)",
   "","notifications,mentions","REQ-NOTIF-001")

tc(E,"Notifications","Mark notification read","Functional","P1","Major","Automated",
   "User has unread notification",
   "1. markNotificationRead(id, true)",
   "read=true; notification no longer shows unread indicator",
   "","notifications","REQ-NOTIF-002")

tc(E,"Notifications","Mark all notifications read","Functional","P1","Major","Automated",
   "User has 5 unread notifications",
   "1. markAllNotificationsRead()",
   "All caller's private notifications marked read; broadcasts left alone",
   "","notifications","REQ-NOTIF-002")

tc(E,"Notifications","Broadcast notifications require admin to mark read","Security","P2","Minor","Automated",
   "MEMBER; broadcast notification exists",
   "1. markNotificationRead(broadcastId, true)",
   "AuthorizationError (broadcasts require role:manage)",
   "","security,notifications,rbac","REQ-NOTIF-002")

tc(E,"Notifications","Dashboard shows limited notifications","Functional","P2","Minor","Automated",
   "User has 100 notifications",
   "1. getDashboardData",
   "Only dashboardNotifLimit (default 20) returned (take cap)",
   "","notifications,performance","REQ-NOTIF-002")

# ===========================================================================
# EPIC 7: Calendar & Events
# ===========================================================================

E = "E7-Calendar"

tc(E,"Create Event","Create calendar event","Functional","P0","Critical","Automated",
   "MANAGER+",
   "1. createEvent({title, date, type:'MEETING'})",
   "Event created; audit event.created",
   "","calendar","REQ-CAL-001")

tc(E,"Create Event","MEMBER cannot create event","Security","P1","Major","Automated",
   "MEMBER",
   "1. createEvent(...)",
   "AuthorizationError (event:create denied)",
   "","security,calendar,rbac","REQ-CAL-001")

tc(E,"Delete Event","Delete event","Functional","P0","Critical","Automated",
   "ADMIN; event exists",
   "1. deleteEvent(id)",
   "Hard-deleted; audit event.deleted",
   "","calendar","REQ-CAL-002")

tc(E,"Delete Event","MEMBER cannot delete event","Security","P1","Major","Automated",
   "MEMBER",
   "1. deleteEvent(id)",
   "AuthorizationError",
   "","security,calendar,rbac","REQ-CAL-002")

tc(E,"Calendar View","Month grid renders events","Functional","P1","Major","Manual",
   "Events exist for current month",
   "1. Navigate to Calendar view",
   "Events appear on correct dates; color-coded by type",
   "","calendar,ui","REQ-CAL-003")

tc(E,"ICS Export","Export calendar as ICS","Functional","P1","Major","Automated",
   "Events exist",
   "1. exportCalendarIcs()",
   "Returns valid RFC 5545 VCALENDAR; one VEVENT per event; PRODID includes APP.name",
   "","calendar,ics","REQ-CAL-004")

tc(E,"ICS Export","ICS folds long lines at 75 octets","Functional","P2","Minor","Automated",
   "Event with very long title",
   "1. exportCalendarIcs()",
   "Lines folded per RFC 5545 (CRLF + space continuation)",
   "","calendar,ics,compliance","REQ-CAL-004")

tc(E,"ICS Export","ICS escapes special characters","Functional","P2","Minor","Automated",
   "Event title with comma, semicolon, newline",
   "1. exportCalendarIcs()",
   "Text escaped per RFC 5545 (backslash prefixes)",
   "","calendar,ics,compliance","REQ-CAL-004")

tc(E,"ICS Export","ICS uses UTC timestamps","Functional","P2","Minor","Automated",
   "Event with local date+time",
   "1. exportCalendarIcs()",
   "DTSTART in UTC (Z suffix)",
   "","calendar,ics,compliance","REQ-CAL-004")

# ===========================================================================
# EPIC 8: Time Tracking
# ===========================================================================

E = "E8-Time"

tc(E,"Log Time","Log time entry","Functional","P0","Critical","Automated",
   "Signed in; has TeamMember row; project exists",
   "1. logTime({projectId, date, hours:4, description:'Work'})",
   "TimeEntry created against caller's roster row; audit time.logged",
   "","time","REQ-TIME-001")

tc(E,"Log Time","Client-supplied memberId ignored","Security","P1","Major","Automated",
   "Signed in as user A; tries to log for member B",
   "1. logTime({memberId: B_id, ...})",
   "memberId derived from getMyTeamMemberId(auth); client value ignored",
   "","security,time","REQ-TIME-001")

tc(E,"Log Time","Hours must be > 0","Functional","P1","Major","Automated",
   "",
   "1. logTime({hours:0})",
   "Zod validation error",
   "","validation,time","REQ-TIME-001")

tc(E,"Log Time","Hours must be <= 24","Functional","P1","Major","Automated",
   "",
   "1. logTime({hours:25})",
   "Zod validation error",
   "","validation,time","REQ-TIME-001")

tc(E,"Log Time","No TeamMember row → error","Functional","P2","Minor","Automated",
   "User has no TeamMember (unusual setup)",
   "1. logTime(...)",
   "AuthorizationError (getMyTeamMemberId returns null)",
   "","time","REQ-TIME-001")

tc(E,"Time Page","Paginated time entries","Functional","P1","Major","Automated",
   "50+ time entries exist",
   "1. getTimeEntriesPage({limit:10})",
   "Returns 10 items + nextCursor; scoped to caller's visible projects",
   "","time,pagination","REQ-TIME-002")

tc(E,"Time Page","Filter by projectId","Functional","P2","Minor","Automated",
   "",
   "1. getTimeEntriesPage({projectId:'p1'})",
   "Only entries for p1 returned",
   "","time,pagination","REQ-TIME-002")

tc(E,"Time Page","Filter by memberId","Functional","P2","Minor","Automated",
   "",
   "1. getTimeEntriesPage({memberId:'m1'})",
   "Only entries for m1 returned",
   "","time,pagination","REQ-TIME-002")

# ===========================================================================
# EPIC 9: Audit Log & Compliance
# ===========================================================================

E = "E9-Audit"

tc(E,"Audit Trail","Every mutating action writes an audit row","Functional","P0","Critical","Automated",
   "",
   "1. Exercise createTask, updateProject, deleteUser, etc.",
   "Each writes an AuditLog row with actor, action, entityType, detail",
   "","audit","REQ-AUDIT-001")

tc(E,"Audit Trail","Audit log includes IP + UA for sign-in","Functional","P1","Major","Automated",
   "User signs in",
   "1. Check audit log for auth.signed_in",
   "ipAddress + userAgent populated (P1 re-audit fix)",
   "","audit,security","REQ-AUDIT-001")

tc(E,"Audit Trail","Audit write failure does not break operation","Functional","P1","Major","Automated",
   "DB outage on AuditLog table",
   "1. Perform a mutation 2. AuditLog.create throws",
   "logAudit swallows error; mutation still succeeds; error logged",
   "","audit,resilience","REQ-AUDIT-001")

tc(E,"Audit View","MANAGER can view audit log","Functional","P0","Critical","Automated",
   "Signed in as MANAGER",
   "1. getAuditLogs()",
   "Returns latest 300 rows (audit:view permission)",
   "","audit,rbac","REQ-AUDIT-002")

tc(E,"Audit View","MEMBER cannot view workspace audit log","Security","P1","Major","Automated",
   "MEMBER",
   "1. getAuditLogs()",
   "AuthorizationError (audit:view denied)",
   "","security,audit,rbac","REQ-AUDIT-002")

tc(E,"Audit View","Entity history for TASK open to any signed-in user","Functional","P1","Major","Automated",
   "Signed in; task exists",
   "1. getAuditLogsForEntity('TASK', taskId)",
   "Returns latest 50 rows (TASK is an 'open' entity type)",
   "","audit","REQ-AUDIT-003")

tc(E,"Audit View","Entity history for USER requires audit:view","Security","P1","Major","Automated",
   "MEMBER; user exists",
   "1. getAuditLogsForEntity('USER', userId)",
   "AuthorizationError (USER is a gated entity type)",
   "","security,audit,rbac","REQ-AUDIT-003")

tc(E,"Audit Retention","Prune audit logs older than retention","Functional","P0","Critical","Automated",
   "ADMIN; retention=180 days; rows older exist",
   "1. pruneAuditLogs()",
   "Rows older than 180 days deleted in batches of 10k; audit.pruned meta-row written BEFORE deletes",
   "","audit,retention","REQ-AUDIT-004")

tc(E,"Audit Retention","Prune requires role:manage (not audit:view)","Security","P1","Critical","Automated",
   "MANAGER (has audit:view, not role:manage)",
   "1. pruneAuditLogs()",
   "AuthorizationError (F-09)",
   "","security,audit,rbac","REQ-AUDIT-004")

tc(E,"Audit Retention","Retention clamped to 30-day minimum","Functional","P1","Major","Automated",
   "Workspace.auditRetentionDays=5",
   "1. pruneAuditLogs()",
   "Uses 30-day floor (clampRetentionDays); 5 ignored",
   "","audit,retention","REQ-AUDIT-004")

tc(E,"Audit Retention","Prune stops after 1M rows","Functional","P2","Minor","Automated",
   "5M old rows",
   "1. pruneAuditLogs()",
   "Deletes 1M rows then stops; next cron run continues",
   "","audit,retention,performance","REQ-AUDIT-004")

tc(E,"Audit Retention","Cron endpoint requires CRON_SECRET","Security","P0","Critical","Automated",
   "CRON_SECRET set",
   "1. GET /api/cron/prune-audit without Bearer token",
   "401 Unauthorized",
   "","security,audit,cron","REQ-AUDIT-005")

tc(E,"Audit Retention","Cron endpoint 503 when CRON_SECRET unset","Functional","P1","Major","Automated",
   "CRON_SECRET not set",
   "1. GET /api/cron/prune-audit with any token",
   "503 Service Unavailable",
   "","audit,cron","REQ-AUDIT-005")

tc(E,"Audit Retention","Cron constant-time token compare","Security","P1","Critical","Manual",
   "CRON_SECRET set",
   "1. Send near-matching token 2. Time the response",
   "Response time consistent regardless of match position (timingSafeEqual)",
   "","security,audit,cron","REQ-AUDIT-005")

tc(E,"Audit Retention","Meta-row written before deletes (forensic integrity)","Security","P1","Critical","Automated",
   "",
   "1. pruneAuditLogs() 2. Inspect order of operations",
   "audit.pruned meta-row written BEFORE the DELETE batches; admin can't suppress evidence post-delete",
   "","security,audit,edge-case","REQ-AUDIT-004")

# ===========================================================================
# EPIC 10: Search & Bulk Ops
# ===========================================================================

E = "E10-Search"

tc(E,"Search","Search tasks by title","Functional","P0","Critical","Automated",
   "Tasks with 'sprint' in title exist",
   "1. searchWorkspace('sprint')",
   "Returns matching tasks (ILIKE); capped at 5 per group",
   "","search","REQ-SRCH-001")

tc(E,"Search","Search projects by name","Functional","P1","Major","Automated",
   "",
   "1. searchWorkspace('proj')",
   "Returns matching projects",
   "","search","REQ-SRCH-001")

tc(E,"Search","Search members by name/email","Functional","P1","Major","Automated",
   "",
   "1. searchWorkspace('ada')",
   "Returns matching team members",
   "","search","REQ-SRCH-001")

tc(E,"Search","Query < 2 chars returns empty","Functional","P1","Major","Automated",
   "",
   "1. searchWorkspace('a')",
   "Returns empty (min length 2)",
   "","search,validation","REQ-SRCH-001")

tc(E,"Search","Query capped at 100 chars","Functional","P2","Minor","Automated",
   "",
   "1. searchWorkspace('x'.repeat(200))",
   "Query truncated to 100 chars before ILIKE",
   "","search,validation","REQ-SRCH-001")

tc(E,"Search","MEMBER search scoped to visible projects","Security","P1","Major","Automated",
   "MEMBER; task in unscoped project matches query",
   "1. searchWorkspace('term')",
   "Unscoped task excluded from results (getScopedProjectIds filter)",
   "","security,search,rbac","REQ-SRCH-001")

tc(E,"Search","Member directory unscoped","Functional","P2","Minor","Automated",
   "MEMBER",
   "1. searchWorkspace('member-name')",
   "Members returned regardless of project scope (team:view semantics)",
   "","search","REQ-SRCH-001")

# ===========================================================================
# EPIC 11: Settings & Config
# ===========================================================================

E = "E11-Settings"

tc(E,"Profile","Update own profile","Functional","P0","Critical","Automated",
   "Signed in",
   "1. updateProfile({name, bio, timezone, avatarColor})",
   "User + TeamMember synced; audit profile.updated",
   "","settings","REQ-SET-001")

tc(E,"Profile","Cannot set role via updateProfile","Security","P1","Critical","Automated",
   "MEMBER",
   "1. updateProfile({role:'ADMIN'})",
   "Schema rejects unknown field (F-01); role unchanged",
   "","security,settings,escalation","REQ-SET-001")

tc(E,"Settings","Update notification preferences","Functional","P1","Major","Automated",
   "Signed in",
   "1. updateUserSettings({notifEmail:false, notifMentions:true})",
   "UserSettings upserted",
   "","settings","REQ-SET-002")

tc(E,"Settings","Update appearance (accent, dark mode)","Functional","P1","Major","Automated",
   "Signed in",
   "1. updateUserSettings({accent:'ocean', dark:true})",
   "Settings persisted; UI re-renders with new theme",
   "","settings,ui","REQ-SET-002")

tc(E,"Change Password","Change password with correct current","Functional","P0","Critical","Automated",
   "Signed in; knows current password",
   "1. changePassword({currentPassword, newPassword})",
   "passwordHash updated; tokenVersion bumped; pending reset tokens invalidated; audit auth.password_changed",
   "","settings,security","REQ-SET-003")

tc(E,"Change Password","Wrong current password rejected","Functional","P0","Critical","Automated",
   "",
   "1. changePassword({currentPassword:'wrong', newPassword:'new'})",
   "AuthorizationError 'Current password is incorrect'",
   "","settings,security","REQ-SET-003")

tc(E,"Change Password","New password must differ from current","Functional","P1","Major","Automated",
   "",
   "1. changePassword({currentPassword:'same', newPassword:'same'})",
   "AuthorizationError 'must be different'",
   "","settings,validation","REQ-SET-003")

tc(E,"Change Password","Max 1024 chars enforced","Functional","P2","Minor","Automated",
   "",
   "1. changePassword with 1MB newPassword",
   "Rejected 'at most 1024 characters'",
   "","settings,validation,edge-case","REQ-SET-003")

tc(E,"Workspace Settings","Update workspace name","Functional","P1","Major","Automated",
   "ADMIN",
   "1. updateWorkspaceSettings({name:'New Org'})",
   "Workspace.upsert; config cache bumped; audit workspace.updated",
   "","settings,workspace","REQ-SET-004")

tc(E,"Workspace Settings","minPasswordLength clamped to 8-128","Functional","P1","Major","Automated",
   "ADMIN",
   "1. updateWorkspaceSettings({minPasswordLength:1})",
   "Zod error (strict schema, min 8)",
   "","settings,workspace,validation","REQ-SET-004")

tc(E,"Workspace Settings","auditRetentionDays clamped to 30-3650","Functional","P1","Major","Automated",
   "ADMIN",
   "1. updateWorkspaceSettings({auditRetentionDays:5})",
   "Zod error (min 30)",
   "","settings,workspace,validation","REQ-SET-004")

tc(E,"Workspace Settings","Unknown fields rejected (strict schema)","Security","P1","Major","Automated",
   "ADMIN",
   "1. updateWorkspaceSettings({maliciousField:'x'})",
   "Zod strict mode rejects unknown keys",
   "","security,settings,validation,edge-case","REQ-SET-004")

tc(E,"Config Items","Create task status config","Functional","P1","Major","Automated",
   "ADMIN",
   "1. createConfigItem('taskStatusConfig', {key:'BLOCKED', label:'Blocked'})",
   "Config row created; cache bumped; audit config.created",
   "","settings,config","REQ-SET-005")

tc(E,"Config Items","Update config item","Functional","P1","Major","Automated",
   "ADMIN; config item exists",
   "1. updateConfigItem('taskStatusConfig', id, {label:'Blocked!'})",
   "Updated; cache bumped; audit config.updated",
   "","settings,config","REQ-SET-005")

tc(E,"Config Items","Delete config item not in use","Functional","P1","Major","Automated",
   "ADMIN; no tasks reference the key",
   "1. deleteConfigItem('taskStatusConfig', id)",
   "Deleted; audit config.deleted",
   "","settings,config","REQ-SET-005")

tc(E,"Config Items","Delete config item in use rejected","Security","P1","Major","Automated",
   "ADMIN; 5 tasks have status='BLOCKED'",
   "1. deleteConfigItem('taskStatusConfig', blockedId)",
   "AuthorizationError '5 tasks still use BLOCKED. Reassign them first.'",
   "","security,settings,config,edge-case","REQ-SET-005")

tc(E,"Config Items","Config item strict schema rejects unknown fields","Security","P2","Minor","Automated",
   "ADMIN",
   "1. createConfigItem('taskStatusConfig', {malicious:'x'})",
   "Zod strict mode rejects",
   "","security,settings,validation,edge-case","REQ-SET-005")

tc(E,"Role Management","Create custom role","Functional","P1","Major","Automated",
   "ADMIN",
   "1. createRole({key:'VIEWER', label:'Viewer', permissions:['team:view']})",
   "Role created; permissions attached; audit role.changed",
   "","settings,roles","REQ-SET-006")

tc(E,"Role Management","Update role permissions atomically","Functional","P1","Major","Automated",
   "ADMIN; role exists with 3 permissions",
   "1. updateRole(roleId, {permissions:['task:create','task:edit:own']})",
   "Old permissions deleted + new attached in $transaction; no duplication",
   "","settings,roles","REQ-SET-006")

tc(E,"Role Management","Delete role with no users","Functional","P1","Major","Automated",
   "ADMIN; custom role with 0 users",
   "1. deleteRole(roleId)",
   "Deleted; audit role.changed",
   "","settings,roles","REQ-SET-006")

tc(E,"Role Management","Delete role with users rejected","Functional","P1","Major","Automated",
   "ADMIN; role has 3 users",
   "1. deleteRole(roleId)",
   "AuthorizationError '3 user(s) still have it'",
   "","settings,roles","REQ-SET-006")

tc(E,"Role Management","System role cannot be deleted","Security","P1","Major","Automated",
   "ADMIN",
   "1. deleteRole(adminRoleId)",
   "AuthorizationError 'System roles cannot be deleted'",
   "","security,settings,roles","REQ-SET-006")

tc(E,"Role Management","Duplicate role key rejected","Functional","P2","Minor","Automated",
   "Role with key 'VIEWER' exists",
   "1. createRole({key:'VIEWER'})",
   "AuthorizationError 'already exists'",
   "","settings,roles,validation","REQ-SET-006")

tc(E,"Privacy","Export my data (GDPR)","Functional","P0","Critical","Automated",
   "Signed in",
   "1. exportMyData()",
   "Returns JSON with all 9 collections (projects, tasks, messages, etc.); each capped at 10k; truncated flag",
   "","privacy,gdpr","REQ-SET-007")

tc(E,"Privacy","Export truncated flag set when cap hit","Functional","P2","Minor","Automated",
   "User has >10k messages",
   "1. exportMyData()",
   "truncated=true in response; user warned to contact admin",
   "","privacy,gdpr,edge-case","REQ-SET-007")

tc(E,"Privacy","Export only returns own data","Security","P1","Critical","Automated",
   "Signed in as user A; user B has data",
   "1. exportMyData()",
   "All queries scoped to auth.userId; B's data absent",
   "","security,privacy","REQ-SET-007")

print(f"After Epics 6-11: {len(CASES)} cases")

# ===========================================================================
# EPIC 12: API & Infrastructure
# ===========================================================================

E = "E12-API"

tc(E,"Health","GET /api/health returns 200 when DB up","Functional","P0","Critical","Automated",
   "App running; DB up",
   "1. GET /api/health",
   "200; {status:'ok', timestamp}; Cache-Control: no-store",
   "","api,health,smoke","REQ-API-001")

tc(E,"Health","GET /api/health returns 503 when DB down","Functional","P0","Critical","Automated",
   "DB down",
   "1. GET /api/health",
   "503; {status:'down'}",
   "","api,health","REQ-API-001")

tc(E,"Health","Redis status reported when configured","Functional","P1","Major","Automated",
   "REDIS_URL set; Redis up",
   "1. GET /api/health?detail=1 with Bearer CRON_SECRET",
   "200; body includes redis:'up'",
   "","api,health","REQ-API-001")

tc(E,"Health","Public health hides db/redis detail","Security","P1","Major","Automated",
   "",
   "1. GET /api/health (no auth)",
   "Body only has status+timestamp; db/redis fields absent",
   "","security,api,health","REQ-API-001")

tc(E,"Health","Detail requires valid CRON_SECRET","Security","P1","Major","Automated",
   "CRON_SECRET set",
   "1. GET /api/health?detail=1 with wrong token",
   "db/redis fields still hidden (isAuthorized=false)",
   "","security,api,health","REQ-API-001")

tc(E,"Health","Redis down does not fail healthcheck","Functional","P2","Minor","Automated",
   "REDIS_URL set; Redis down",
   "1. GET /api/health?detail=1 (authorized)",
   "200 (not 503); redis:'down'; status:'ok' (fail-open)",
   "","api,health,resilience","REQ-API-001")

tc(E,"Client Errors","POST /api/client-errors accepts valid report","Functional","P1","Major","Automated",
   "Same-origin request",
   "1. POST /api/client-errors with {message, digest, source}",
   "204; captureError called; no response body",
   "","api,errors","REQ-API-002")

tc(E,"Client Errors","Cross-origin POST rejected","Security","P1","Major","Automated",
   "APP_URL set; request from evil.example",
   "1. POST with Origin: evil.example",
   "403 Forbidden",
   "","security,api,errors","REQ-API-002")

tc(E,"Client Errors","Oversized payload dropped (8KB cap)","Functional","P2","Minor","Automated",
   "",
   "1. POST with 10KB body",
   "204 (silently dropped); captureError NOT called",
   "","api,errors","REQ-API-002")

tc(E,"Client Errors","Malformed JSON dropped","Functional","P2","Minor","Automated",
   "",
   "1. POST with 'not-json{'",
   "204; captureError NOT called",
   "","api,errors","REQ-API-002")

tc(E,"Client Errors","GET returns 405","Functional","P2","Minor","Automated",
   "",
   "1. GET /api/client-errors",
   "405; Allow: POST",
   "","api,errors","REQ-API-002")

tc(E,"Cron","Cron prune succeeds with valid token","Functional","P0","Critical","Automated",
   "CRON_SECRET set; audit logs to prune",
   "1. GET /api/cron/prune-audit with Bearer CRON_SECRET",
   "200; {ok, deletedCount, retentionDays}",
   "","api,cron","REQ-API-003")

tc(E,"Cron","Cron 1-hour dedup guard","Functional","P1","Major","Automated",
   "Prune ran 30 min ago",
   "1. Call cron again",
   "Skipped (per-instance lastRunAt guard); returns 'skipped'",
   "","api,cron","REQ-API-003")

tc(E,"API Discovery","GET /api returns name + health","Functional","P2","Minor","Automated",
   "",
   "1. GET /api",
   "200; {name:'Fernly API', health:'/api/health'}",
   "","api","REQ-API-004")

tc(E,"API Discovery","No stale /docs reference","Functional","P3","Trivial","Automated",
   "",
   "1. GET /api 2. Check body",
   "No 'docs' field (was removed — no /docs route exists)",
   "","api","REQ-API-004")

# ===========================================================================
# EPIC 13: Security & Penetration
# ===========================================================================

E = "E13-Security"

tc(E,"SQL Injection","No raw SQL injection surface","Security","P0","Critical","Manual",
   "",
   "1. Audit all $queryRaw/$executeRaw calls 2. Verify parameterized",
   "Only 2 raw SQL sites (health SELECT 1, audit prune parameterized DELETE); no string interpolation",
   "","security,sqli","REQ-SEC-001")

tc(E,"XSS","No dangerouslySetInnerHTML anywhere","Security","P0","Critical","Automated",
   "",
   "1. grep src/ for dangerouslySetInnerHTML",
   "Zero matches; React escapes all user input by default",
   "","security,xss","REQ-SEC-002")

tc(E,"XSS","User display name escaped in reset email","Security","P1","Major","Automated",
   "User with name '<script>'",
   "1. Request password reset",
   "Email HTML-escapes name; no script execution",
   "","security,xss,password-reset","REQ-SEC-002")

tc(E,"CSRF","Server Actions origin check","Security","P0","Critical","Automated",
   "SERVER_ACTIONS_ALLOWED_ORIGINS set",
   "1. POST server action from disallowed origin",
   "Next.js rejects (allowedOrigins gate)",
   "","security,csrf","REQ-SEC-003")

tc(E,"CSRF","Boot guard requires SERVER_ACTIONS_ALLOWED_ORIGINS in prod","Security","P1","Critical","Automated",
   "NODE_ENV=production; var unset",
   "1. Boot the app",
   "process.exit(1) with FATAL log",
   "","security,csrf,boot","REQ-SEC-003")

tc(E,"CSRF","Wildcard '*' origin rejected by boot guard","Security","P1","Major","Automated",
   "SERVER_ACTIONS_ALLOWED_ORIGINS='*'",
   "1. Boot in production",
   "process.exit(1) (wildcard is insecure)",
   "","security,csrf,edge-case","REQ-SEC-003")

tc(E,"CSP","CSP nonce-based in production","Security","P1","Major","Automated",
   "Production build",
   "1. GET any app page 2. Inspect Content-Security-Policy header",
   "script-src 'self' 'nonce-<per-request>'; no 'unsafe-inline'",
   "","security,csp","REQ-SEC-004")

tc(E,"CSP","CSP allows unsafe-eval in dev only","Functional","P2","Minor","Automated",
   "NODE_ENV=development",
   "1. GET app page",
   "script-src includes 'unsafe-eval' (HMR/React Refresh)",
   "","security,csp","REQ-SEC-004")

tc(E,"Headers","HSTS set","Security","P1","Major","Automated",
   "",
   "1. GET any page",
   "Strict-Transport-Security: max-age=31536000",
   "","security,headers","REQ-SEC-005")

tc(E,"Headers","X-Frame-Options: DENY","Security","P1","Major","Automated",
   "",
   "1. GET any page",
   "X-Frame-Options: DENY (clickjacking protection)",
   "","security,headers","REQ-SEC-005")

tc(E,"Headers","X-Content-Type-Options: nosniff","Security","P2","Minor","Automated",
   "",
   "1. GET any page",
   "X-Content-Type-Options: nosniff",
   "","security,headers","REQ-SEC-005")

tc(E,"Headers","Referrer-Policy: strict-origin-when-cross-origin","Security","P2","Minor","Automated",
   "",
   "1. GET any page",
   "Referrer-Policy header set",
   "","security,headers","REQ-SEC-005")

tc(E,"Headers","Permissions-Policy restrictive","Security","P2","Minor","Automated",
   "",
   "1. GET any page",
   "camera=(), microphone=(), geolocation=(), payment=()",
   "","security,headers","REQ-SEC-005")

tc(E,"Secrets","No hardcoded secrets in source","Security","P0","Critical","Automated",
   "",
   "1. grep src/ scripts/ e2e/ for secret patterns",
   "All secrets read from env; no credential literals",
   "","security,secrets","REQ-SEC-006")

tc(E,"Secrets","Production build greppable-clean of demo creds","Security","P0","Critical","Automated",
   "Production build",
   "1. grep .next/static for 'fernly123' / 'demo@fernly.app'",
   "Zero matches (CI gate)",
   "","security,secrets,ci","REQ-SEC-006")

tc(E,"Secrets",".env stripped from standalone build","Security","P0","Critical","Automated",
   "Build complete",
   "1. ls .next/standalone/.env*",
   "No .env files in standalone output (rm -f in build script)",
   "","security,secrets,build","REQ-SEC-006")

tc(E,"Secrets",".gitignore excludes .env*","Security","P0","Critical","Automated",
   "",
   "1. git ls-files | grep .env",
   "Zero .env files tracked",
   "","security,secrets","REQ-SEC-006")

tc(E,"PII","Login logs hash email + IP","Security","P1","Major","Automated",
   "",
   "1. Trigger login throttle 2. Inspect log",
   "Email not in cleartext; IP hashed via hashPii (SHA-256, 8 hex chars)",
   "","security,pii,logging","REQ-SEC-007")

tc(E,"PII","Mailer errors hash recipient","Security","P1","Major","Automated",
   "RESEND_API_KEY invalid",
   "1. Trigger mail send failure",
   "Error message uses hashPii(input.to); no recipient email in logs",
   "","security,pii,logging","REQ-SEC-007")

tc(E,"PII","Sentry payloads scrubbed of secrets","Security","P1","Critical","Automated",
   "SENTRY_DSN set",
   "1. Trigger error with DB URL in message 2. Inspect Sentry payload",
   "redactSecrets scrubs: Bearer tokens, DB URLs, JWTs, emails, password= params, long base64",
   "","security,pii,observability","REQ-SEC-007")

tc(E,"Rate Limiting","Login rate limit 5/15min/email","Security","P0","Critical","Automated",
   "",
   "1. 5 failed logins 2. 6th attempt",
   "6th blocked",
   "","security,rate-limit","REQ-SEC-008")

tc(E,"Rate Limiting","Rate limit fails open on Redis outage","Functional","P1","Major","Automated",
   "Redis down",
   "1. Attempt login",
   "Limiter fails open (blocked:false); login still possible; structured metric=rate_limit_fail_open logged",
   "","security,rate-limit,resilience","REQ-SEC-008")

tc(E,"Rate Limiting","Redis key prefix configurable","Functional","P2","Minor","Automated",
   "REDIS_KEY_PREFIX='app:'",
   "1. Hit login limiter 2. Inspect Redis keys",
   "Keys prefixed with 'app:login:' (configurable, default 'app:')",
   "","security,rate-limit,config","REQ-SEC-008")

tc(E,"Timing","Anti-enumeration: unknown email burns bcrypt","Security","P1","Major","Automated",
   "",
   "1. Submit unknown email 2. Measure response time",
   "bcrypt dummy compare runs (cost 12); response time ~ same as known user wrong password",
   "","security,timing,enumeration","REQ-SEC-009")

tc(E,"Timing","Constant-time CRON_SECRET compare","Security","P1","Critical","Manual",
   "",
   "1. Send near-matching CRON_SECRET 2. Time response",
   "Response time independent of match length",
   "","security,timing,cron","REQ-SEC-009")

tc(E,"Boot Guard","App refuses to boot with weak NEXTAUTH_SECRET in prod","Security","P0","Critical","Automated",
   "NODE_ENV=production; NEXTAUTH_SECRET='weak'",
   "1. Boot",
   "Throws (auth.ts:26-32 boot guard)",
   "","security,boot","REQ-SEC-010")

tc(E,"Boot Guard","App boots during next build without NEXTAUTH_SECRET","Functional","P1","Major","Automated",
   "phase=production-build",
   "1. next build",
   "Boot guard skipped (build-phase exemption); build succeeds",
   "","security,boot,build","REQ-SEC-010")

tc(E,"Instrumentation","unhandledRejection captured to Sentry","Functional","P1","Major","Automated",
   "SENTRY_DSN set",
   "1. Trigger an unhandled rejection 2. Check Sentry",
   "captureError called with source:'unhandledRejection'",
   "","observability,instrumentation","REQ-SEC-011")

tc(E,"Instrumentation","uncaughtException exits process (non-shutdown)","Functional","P1","Major","Automated",
   "",
   "1. Trigger uncaughtException",
   "captureError called; process.exit(1) after 1s delay",
   "","observability,instrumentation","REQ-SEC-011")

tc(E,"Instrumentation","uncaughtException during shutdown does not force-exit","Functional","P1","Major","Automated",
   "SIGTERM received (shuttingDown=true)",
   "1. Trigger uncaughtException during drain",
   "Logged but no process.exit (graceful shutdown preserved)",
   "","observability,instrumentation,edge-case","REQ-SEC-011")

# ===========================================================================
# EPIC 14: Performance & Load
# ===========================================================================

E = "E14-Performance"

tc(E,"Dashboard","Dashboard loads in <2s with 200 projects","Performance","P1","Major","Manual",
   "200 projects, 1000 tasks, 500 members",
   "1. Load dashboard as ADMIN",
   "SSR response <2s (take:200 caps on all queries; date-window on timeEntries/events)",
   "","performance,dashboard","REQ-PERF-001")

tc(E,"Dashboard","Dashboard with 10k tasks does not OOM","Performance","P1","Major","Manual",
   "10k tasks",
   "1. Load dashboard",
   "take:200 caps prevent OOM; only 200 tasks loaded; rest paginated",
   "","performance,dashboard,edge-case","REQ-PERF-001")

tc(E,"Pagination","Cursor pagination returns in <500ms","Performance","P2","Minor","Manual",
   "10k rows",
   "1. getUsersPage({limit:50})",
   "<500ms (indexed cursor + take:51)",
   "","performance,pagination","REQ-PERF-002")

tc(E,"Pagination","Malformed cursor returns first page (no 500)","Performance","P1","Major","Automated",
   "",
   "1. getUsersPage({cursor:'malformed'})",
   "safeCursor returns null; first page returned (no P2015 throw)",
   "","performance,pagination,edge-case","REQ-PERF-002")

tc(E,"Search","Search returns in <1s with 10k tasks","Performance","P2","Minor","Manual",
   "10k tasks",
   "1. searchWorkspace('sprint')",
   "<1s (ILIKE with take:5 cap per group)",
   "","performance,search","REQ-PERF-003")

tc(E,"Mentions","Mention parsing with 10k users does not load all","Performance","P1","Major","Automated",
   "10k users",
   "1. createTask with @mention",
   "User query scoped to mention-token ILIKE + take:500; not all 10k loaded",
   "","performance,mentions,edge-case","REQ-PERF-004")

tc(E,"Bundle","Main bundle < 200KB gzipped","Performance","P0","Critical","Automated",
   "Production build",
   "1. bun run bundle:check",
   "All 'main' chunks < 200KB (build-manifest-driven categorization)",
   "","performance,bundle,ci","REQ-PERF-005")

tc(E,"Bundle","Lazy chunks < 250KB gzipped","Performance","P0","Critical","Automated",
   "Production build",
   "1. bun run bundle:check",
   "All 'lazy' chunks < 250KB",
   "","performance,bundle,ci","REQ-PERF-005")

tc(E,"Bundle","Framework chunks < 150KB gzipped","Performance","P1","Major","Automated",
   "",
   "1. bundle:check",
   "Framework chunks < 150KB",
   "","performance,bundle,ci","REQ-PERF-005")

tc(E,"Load","k6 load test: 50 VUs for 5 min","Performance","P1","Major","Manual",
   "App deployed; k6 installed",
   "1. k6 run scripts/load-test.k6.js",
   "p95 < 1.5s (login), < 400ms (dashboard), < 2s (tasks); < 1% errors",
   "","performance,load,k6","REQ-PERF-006")

tc(E,"Load","100k-row seed-load generator","Performance","P2","Minor","Manual",
   "SEED_LOAD=1",
   "1. node scripts/seed-load.js --confirm",
   "100k tasks/projects/members created; --confirm required on non-localhost",
   "","performance,load,seed","REQ-PERF-006")

tc(E,"Config Cache","Config cache TTL 10s","Performance","P2","Minor","Automated",
   "",
   "1. getWorkspaceConfig 2. Wait 11s 3. getWorkspaceConfig",
   "Cache expired; DB re-queried (TTL shortened from 60s for multi-instance RBAC freshness)",
   "","performance,cache","REQ-PERF-007")

tc(E,"Config Cache","bumpConfigCache invalidates immediately","Functional","P1","Major","Automated",
   "",
   "1. getWorkspaceConfig 2. updateWorkspaceSettings 3. getWorkspaceConfig",
   "Cache cleared via bumpConfigCache; next read sees new values instantly (same instance)",
   "","performance,cache","REQ-PERF-007")

# ===========================================================================
# EPIC 15: UI/UX & Accessibility
# ===========================================================================

E = "E15-UI"

tc(E,"Navigation","Sidebar shows role-gated entries","Functional","P0","Critical","Automated",
   "",
   "1. Sign in as ADMIN vs MEMBER 2. Compare sidebar",
   "ADMIN sees Users/WorkspaceSettings/Audit; MEMBER does not (hasPermission gate)",
   "","ui,navigation,rbac,e2e","REQ-UI-001")

tc(E,"Navigation","Keyboard shortcut G D goes to Dashboard","Functional","P1","Major","Automated",
   "Signed in",
   "1. Press G then D",
   "Dashboard view activated",
   "","ui,keyboard","REQ-UI-002")

tc(E,"Navigation","Cmd+K opens command palette","Functional","P0","Critical","Automated",
   "Signed in",
   "1. Press Cmd+K (Mac) / Ctrl+K (Win)",
   "Command palette opens with navigation + search",
   "","ui,command-palette","REQ-UI-003")

tc(E,"Command Palette","Search from command palette","Functional","P1","Major","Automated",
   "Palette open",
   "1. Type 'sprint' 2. Enter",
   "searchWorkspace called; results rendered; Enter navigates",
   "","ui,command-palette,search","REQ-UI-003")

tc(E,"Command Palette","Escape closes palette","Functional","P2","Minor","Automated",
   "Palette open",
   "1. Press Escape",
   "Palette closes; focus returned to trigger",
   "","ui,command-palette,keyboard","REQ-UI-003")

tc(E,"Kanban","Drag task to another column","Functional","P0","Critical","Automated",
   "Tasks view; task in TODO",
   "1. Drag task card to IN_PROGRESS column",
   "moveTask called; task status updated; board re-renders",
   "","ui,kanban,e2e","REQ-UI-004")

tc(E,"Kanban","Filter bar filters tasks","Functional","P1","Major","Manual",
   "Tasks view with 20 tasks",
   "1. Type 'sprint' in filter bar",
   "Only tasks matching filter shown",
   "","ui,kanban","REQ-UI-004")

tc(E,"Modals","Modal focus trap","Accessibility","P1","Major","Automated",
   "Modal open",
   "1. Press Tab repeatedly",
   "Focus cycles within modal; does not escape to background",
   "","ui,a11y,modal","REQ-UI-005")

tc(E,"Modals","Escape closes modal","Functional","P1","Major","Automated",
   "Modal open",
   "1. Press Escape",
   "Modal closes; focus returned to trigger",
   "","ui,modal,keyboard","REQ-UI-005")

tc(E,"Modals","Click outside closes modal","Functional","P2","Minor","Manual",
   "Modal open",
   "1. Click backdrop",
   "Modal closes",
   "","ui,modal","REQ-UI-005")

tc(E,"Theme","Dark mode toggle","Functional","P1","Major","Manual",
   "Signed in",
   "1. Settings → Appearance → Dark mode ON",
   "UI switches to dark theme; persisted in UserSettings",
   "","ui,theme","REQ-UI-006")

tc(E,"Theme","Accent color change","Functional","P2","Minor","Manual",
   "Signed in",
   "1. Settings → Appearance → Accent: Ocean",
   "All accent-dependent UI updates; persisted",
   "","ui,theme","REQ-UI-006")

tc(E,"Theme","Theme persists across sessions","Functional","P2","Minor","Manual",
   "Theme set; sign out + sign in",
   "1. Sign out 2. Sign back in",
   "Theme restored from UserSettings (not localStorage only)",
   "","ui,theme","REQ-UI-006")

tc(E,"Responsive","Mobile login screen","Functional","P2","Minor","Manual",
   "Mobile viewport",
   "1. Navigate to / on mobile",
   "Login form renders correctly; no horizontal scroll",
   "","ui,responsive,mobile","REQ-UI-007")

tc(E,"Responsive","Mobile dashboard","Functional","P2","Minor","Manual",
   "Mobile viewport; signed in",
   "1. View dashboard on mobile",
   "Cards stack vertically; navigation accessible",
   "","ui,responsive,mobile","REQ-UI-007")

tc(E,"Error Pages","404 page renders","Functional","P1","Major","Automated",
   "",
   "1. Navigate to /nonexistent",
   "not-found.tsx renders with branded 404",
   "","ui,error-pages","REQ-UI-008")

tc(E,"Error Pages","App error boundary renders","Functional","P1","Major","Automated",
   "Throw in a client component",
   "1. Trigger client error",
   "error.tsx renders with reset button; error reported via window bridge",
   "","ui,error-pages","REQ-UI-008")

tc(E,"Error Pages","Global error boundary reports to /api/client-errors","Functional","P1","Major","Automated",
   "Root layout crashes",
   "1. Trigger global error",
   "global-error.tsx POSTs directly to /api/client-errors (bridge unavailable)",
   "","ui,error-pages,edge-case","REQ-UI-008")

tc(E,"Error Pages","Error digest shown","Functional","P2","Minor","Automated",
   "Error triggered",
   "1. Inspect error page",
   "error.digest displayed (hashed error id for support tickets)",
   "","ui,error-pages","REQ-UI-008")

tc(E,"Loading","Loading state renders during SSR","Functional","P2","Minor","Automated",
   "",
   "1. Navigate to a slow route",
   "loading.tsx renders with branded spinner",
   "","ui,loading","REQ-UI-009")

tc(E,"Empty States","Empty state when no projects","Functional","P2","Minor","Manual",
   "New workspace; no projects",
   "1. View dashboard",
   "EmptyState component with helpful message + CTA",
   "","ui,empty-states","REQ-UI-010")

tc(E,"Empty States","Empty state when no tasks","Functional","P2","Minor","Manual",
   "Project with no tasks",
   "1. View tasks",
   "EmptyState on each empty column",
   "","ui,empty-states","REQ-UI-010")

tc(E,"Accessibility","Keyboard navigation through Kanban","Accessibility","P1","Major","Manual",
   "Tasks view",
   "1. Tab through the board",
   "All interactive elements reachable via keyboard; visible focus ring",
   "","ui,a11y","REQ-UI-011")

tc(E,"Accessibility","ARIA labels on icon buttons","Accessibility","P2","Minor","Manual",
   "",
   "1. Inspect icon-only buttons (close, menu, etc.)",
   "aria-label present on each",
   "","ui,a11y","REQ-UI-011")

tc(E,"Accessibility","Color contrast meets WCAG AA","Accessibility","P2","Minor","Manual",
   "",
   "1. Run axe DevTools on each view",
   "No contrast violations (OKLCH tokens tuned for AA)",
   "","ui,a11y","REQ-UI-011")

tc(E,"Internationalization","t() indirection for all UI strings","Functional","P2","Minor","Automated",
   "",
   "1. Audit view components for hardcoded strings",
   "All user-facing strings go through t() (L-P2-32 i18n prep)",
   "","ui,i18n","REQ-UI-012")

print(f"\n=== Total: {len(CASES)} test cases ===")

# ---------------------------------------------------------------------------
# Generate Excel workbook
# ---------------------------------------------------------------------------

wb = Workbook()
ws = wb.active
ws.title = "Test Cases"

# --- Styles ---
HEADER_FILL = PatternFill(start_color="1F2937", end_color="1F2937", fill_type="solid")
HEADER_FONT = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
CELL_FONT = Font(name="Calibri", size=10)
WRAP = Alignment(wrap_text=True, vertical="top")
THIN_BORDER = Border(
    left=Side(style="thin", color="E5E7EB"),
    right=Side(style="thin", color="E5E7EB"),
    top=Side(style="thin", color="E5E7EB"),
    bottom=Side(style="thin", color="E5E7EB"),
)

# Priority fills
PRIORITY_FILLS = {
    "P0": PatternFill(start_color="FEE2E2", end_color="FEE2E2", fill_type="solid"),
    "P1": PatternFill(start_color="FED7AA", end_color="FED7AA", fill_type="solid"),
    "P2": PatternFill(start_color="FEF3C7", end_color="FEF3C7", fill_type="solid"),
    "P3": PatternFill(start_color="E0E7FF", end_color="E0E7FF", fill_type="solid"),
}

# Epic colors (for the Epic column)
EPIC_COLORS = {
    "E1-Auth": "DBEAFE",
    "E2-RBAC": "E0E7FF",
    "E3-Tasks": "D1FAE5",
    "E4-Projects": "FCE7F3",
    "E5-Team": "FED7AA",
    "E6-Messaging": "FEE2E2",
    "E7-Calendar": "FEF3C7",
    "E8-Time": "CFFAFE",
    "E9-Audit": "F3E8FF",
    "E10-Search": "E5E7EB",
    "E11-Settings": "FDF4FF",
    "E12-API": "ECFDF5",
    "E13-Security": "FEE2E2",
    "E14-Performance": "E0F2FE",
    "E15-UI": "F9FAFB",
}

# --- Headers ---
headers = [
    "ID", "Epic", "Feature Area", "Title", "Type", "Priority", "Severity",
    "Automation Status", "Precondition", "Steps", "Expected",
    "Test Data", "Tags", "Linked Requirement",
]
for col, h in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=h)
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cell.border = THIN_BORDER

# --- Data rows ---
for row_idx, case in enumerate(CASES, 2):
    for col, key in enumerate(headers, 1):
        cell = ws.cell(row=row_idx, column=col, value=case[key])
        cell.font = CELL_FONT
        cell.alignment = WRAP
        cell.border = THIN_BORDER
    # Color the Priority cell
    prio = case["Priority"]
    if prio in PRIORITY_FILLS:
        ws.cell(row=row_idx, column=6).fill = PRIORITY_FILLS[prio]
    # Color the Epic cell
    epic = case["Epic"]
    epic_color = EPIC_COLORS.get(epic, "FFFFFF")
    ws.cell(row=row_idx, column=2).fill = PatternFill(
        start_color=epic_color, end_color=epic_color, fill_type="solid"
    )

# --- Column widths ---
widths = {
    "A": 10,  # ID
    "B": 14,  # Epic
    "C": 18,  # Feature Area
    "D": 48,  # Title
    "E": 14,  # Type
    "F": 9,   # Priority
    "G": 10,  # Severity
    "H": 14,  # Automation Status
    "I": 35,  # Precondition
    "J": 45,  # Steps
    "K": 45,  # Expected
    "L": 20,  # Test Data
    "M": 28,  # Tags
    "N": 18,  # Linked Requirement
}
for col_letter, w in widths.items():
    ws.column_dimensions[col_letter].width = w

# Row height for header
ws.row_dimensions[1].height = 32
# Freeze top row
ws.freeze_panes = "A2"

# Auto-filter on all columns
ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(CASES)+1}"

# ---------------------------------------------------------------------------
# Sheet 2: Summary by Epic
# ---------------------------------------------------------------------------
ws2 = wb.create_sheet("Summary")

# Epic summary
summary_data = {}
for c in CASES:
    e = c["Epic"]
    if e not in summary_data:
        summary_data[e] = {"total": 0, "P0": 0, "P1": 0, "P2": 0, "P3": 0, "Automated": 0, "Manual": 0}
    summary_data[e]["total"] += 1
    summary_data[e][c["Priority"]] += 1
    if c["Automation Status"] == "Automated":
        summary_data[e]["Automated"] += 1
    else:
        summary_data[e]["Manual"] += 1

# Headers
sum_headers = ["Epic", "Total", "P0", "P1", "P2", "P3", "Automated", "Manual"]
for col, h in enumerate(sum_headers, 1):
    cell = ws2.cell(row=1, column=col, value=h)
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = Alignment(horizontal="center")
    cell.border = THIN_BORDER

for row_idx, (epic, counts) in enumerate(summary_data.items(), 2):
    ws2.cell(row=row_idx, column=1, value=epic).fill = PatternFill(
        start_color=EPIC_COLORS.get(epic, "FFFFFF"),
        end_color=EPIC_COLORS.get(epic, "FFFFFF"),
        fill_type="solid",
    )
    ws2.cell(row=row_idx, column=2, value=counts["total"])
    ws2.cell(row=row_idx, column=3, value=counts["P0"])
    ws2.cell(row=row_idx, column=4, value=counts["P1"])
    ws2.cell(row=row_idx, column=5, value=counts["P2"])
    ws2.cell(row=row_idx, column=6, value=counts["P3"])
    ws2.cell(row=row_idx, column=7, value=counts["Automated"])
    ws2.cell(row=row_idx, column=8, value=counts["Manual"])
    for col in range(1, 9):
        ws2.cell(row=row_idx, column=col).font = CELL_FONT
        ws2.cell(row=row_idx, column=col).border = THIN_BORDER
        ws2.cell(row=row_idx, column=col).alignment = Alignment(horizontal="center" if col > 1 else "left")

# Totals row
total_row = len(summary_data) + 2
ws2.cell(row=total_row, column=1, value="TOTAL").font = Font(bold=True)
ws2.cell(row=total_row, column=2, value=f"=SUM(B2:B{total_row-1})").font = Font(bold=True)
ws2.cell(row=total_row, column=3, value=f"=SUM(C2:C{total_row-1})").font = Font(bold=True)
ws2.cell(row=total_row, column=4, value=f"=SUM(D2:D{total_row-1})").font = Font(bold=True)
ws2.cell(row=total_row, column=5, value=f"=SUM(E2:E{total_row-1})").font = Font(bold=True)
ws2.cell(row=total_row, column=6, value=f"=SUM(F2:F{total_row-1})").font = Font(bold=True)
ws2.cell(row=total_row, column=7, value=f"=SUM(G2:G{total_row-1})").font = Font(bold=True)
ws2.cell(row=total_row, column=8, value=f"=SUM(H2:H{total_row-1})").font = Font(bold=True)
for col in range(1, 9):
    ws2.cell(row=total_row, column=col).border = THIN_BORDER
    ws2.cell(row=total_row, column=col).fill = PatternFill(start_color="F3F4F6", end_color="F3F4F6", fill_type="solid")

ws2.column_dimensions["A"].width = 18
for col_letter in ["B","C","D","E","F","G","H"]:
    ws2.column_dimensions[col_letter].width = 12
ws2.freeze_panes = "A2"

# ---------------------------------------------------------------------------
# Sheet 3: Coverage Matrix (Type × Priority)
# ---------------------------------------------------------------------------
ws3 = wb.create_sheet("Coverage Matrix")

types = ["Functional","Security","Performance","E2E","Integration","Smoke","Regression","Negative","Accessibility","Manual"]
prios = ["P0","P1","P2","P3"]

# Headers
ws3.cell(row=1, column=1, value="Type \\ Priority").fill = HEADER_FILL
ws3.cell(row=1, column=1).font = HEADER_FONT
ws3.cell(row=1, column=1).alignment = Alignment(horizontal="center")
ws3.cell(row=1, column=1).border = THIN_BORDER
for col, p in enumerate(prios, 2):
    cell = ws3.cell(row=1, column=col, value=p)
    cell.fill = HEADER_FILL
    cell.font = HEADER_FONT
    cell.alignment = Alignment(horizontal="center")
    cell.border = THIN_BORDER
ws3.cell(row=1, column=len(prios)+2, value="Total").fill = HEADER_FILL
ws3.cell(row=1, column=len(prios)+2).font = HEADER_FONT
ws3.cell(row=1, column=len(prios)+2).alignment = Alignment(horizontal="center")
ws3.cell(row=1, column=len(prios)+2).border = THIN_BORDER

for row_idx, t in enumerate(types, 2):
    ws3.cell(row=row_idx, column=1, value=t).font = CELL_FONT
    ws3.cell(row=row_idx, column=1).border = THIN_BORDER
    total_for_type = 0
    for col, p in enumerate(prios, 2):
        count = sum(1 for c in CASES if c["Type"] == t and c["Priority"] == p)
        ws3.cell(row=row_idx, column=col, value=count if count > 0 else "").font = CELL_FONT
        ws3.cell(row=row_idx, column=col).alignment = Alignment(horizontal="center")
        ws3.cell(row=row_idx, column=col).border = THIN_BORDER
        total_for_type += count
    ws3.cell(row=row_idx, column=len(prios)+2, value=total_for_type).font = Font(bold=True)
    ws3.cell(row=row_idx, column=len(prios)+2).alignment = Alignment(horizontal="center")
    ws3.cell(row=row_idx, column=len(prios)+2).border = THIN_BORDER

# Totals row
trow = len(types) + 2
ws3.cell(row=trow, column=1, value="TOTAL").font = Font(bold=True)
for col, p in enumerate(prios, 2):
    ws3.cell(row=trow, column=col, value=f"=SUM({get_column_letter(col)}2:{get_column_letter(col)}{trow-1})").font = Font(bold=True)
ws3.cell(row=trow, column=len(prios)+2, value=f"=SUM({get_column_letter(len(prios)+2)}2:{get_column_letter(len(prios)+2)}{trow-1})").font = Font(bold=True)
for col in range(1, len(prios)+3):
    ws3.cell(row=trow, column=col).border = THIN_BORDER
    ws3.cell(row=trow, column=col).fill = PatternFill(start_color="F3F4F6", end_color="F3F4F6", fill_type="solid")

ws3.column_dimensions["A"].width = 18
for col_letter in ["B","C","D","E","F"]:
    ws3.column_dimensions[col_letter].width = 10
ws3.freeze_panes = "B2"

# ---------------------------------------------------------------------------
# Sheet 4: Test Plan Info
# ---------------------------------------------------------------------------
ws4 = wb.create_sheet("Test Plan", 0)  # First sheet

ws4.column_dimensions["A"].width = 30
ws4.column_dimensions["B"].width = 70

info = [
    ("Test Plan Name", "Fernly — Full QA Test Suite"),
    ("Project", "Fernly (Kanban Project Management)"),
    ("Version", "1.0"),
    ("Author", "Principal QA Engineer"),
    ("Date Generated", datetime.now().strftime("%Y-%m-%d %H:%M UTC")),
    ("Total Test Cases", str(len(CASES))),
    ("Total Epics", "15"),
    ("", ""),
    ("ADO Import Instructions", "Use Excel/CSV import in ADO Test Plans. Map columns: Title→Test Case Title, Steps→Steps, Expected→Expected Result, Priority→Priority, Tags→Tags. Create one Test Suite per Epic."),
    ("", ""),
    ("Automation Coverage", f"{sum(1 for c in CASES if c['Automation Status']=='Automated')}/{len(CASES)} ({100*sum(1 for c in CASES if c['Automation Status']=='Automated')//len(CASES)}%)"),
    ("Manual Coverage", f"{sum(1 for c in CASES if c['Automation Status']=='Manual')}/{len(CASES)} ({100*sum(1 for c in CASES if c['Automation Status']=='Manual')//len(CASES)}%)"),
    ("", ""),
    ("Priority Breakdown", ""),
    ("P0 (Critical)", str(sum(1 for c in CASES if c["Priority"]=="P0"))),
    ("P1 (Major)", str(sum(1 for c in CASES if c["Priority"]=="P1"))),
    ("P2 (Minor)", str(sum(1 for c in CASES if c["Priority"]=="P2"))),
    ("P3 (Trivial)", str(sum(1 for c in CASES if c["Priority"]=="P3"))),
    ("", ""),
    ("Stack", "Next.js 16 + React 19 + TypeScript + Prisma 6 + PostgreSQL (Supabase) + NextAuth v4"),
    ("Repo", "https://github.com/AIProjects-San/kanban"),
    ("Existing Automation", "749 vitest unit/integration + 16 Cucumber/Selenium e2e"),
]

for row_idx, (label, value) in enumerate(info, 1):
    cell_a = ws4.cell(row=row_idx, column=1, value=label)
    cell_a.font = Font(bold=True, size=11)
    cell_a.alignment = Alignment(vertical="top")
    cell_b = ws4.cell(row=row_idx, column=2, value=value)
    cell_b.font = Font(size=11)
    cell_b.alignment = Alignment(wrap_text=True, vertical="top")

# ---------------------------------------------------------------------------
# Save
# ---------------------------------------------------------------------------
output_path = "/home/z/my-project/download/Fernly-QA-Test-Cases.xlsx"
wb.save(output_path)
print(f"\n✅ Workbook saved: {output_path}")
print(f"   {len(CASES)} test cases across 15 epics")
print(f"   4 sheets: Test Plan | Test Cases | Summary | Coverage Matrix")
