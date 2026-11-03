"use server";

// ---------------------------------------------------------------------------
// L-P0-9 — Paginated list actions with server-side search.
//
// Four cursor-paginated + search-enabled list actions: getUsersPage,
// getTasksPage, getProjectsPage, getTimeEntriesPage. Each accepts
// { cursor?, limit?, search?, ...filters } and returns { items, nextCursor,
// hasMore }. Uses Prisma's cursor idiom (cursor + skip:1 + take:limit+1) and
// inspects the extra row to compute hasMore without a count query.
//
// limit defaults to 50, clamped to 200 max. Search is server-side ILIKE
// (mode: "insensitive"). All actions apply the L-P0-14 soft-delete filter.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { requirePermission, getSession, AuthorizationError } from "./auth-guard";
import { getScopedProjectIds, getVisibleMemberIds } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/**
 * P2 (edge-case audit) — validate the cursor format before passing it to
 * Prisma. A malformed or stale cursor (not a cuid, points to a hard-deleted
 * row) previously caused Prisma's `cursor: { id }` to throw P2015 → 500 →
 * broken UI. Now: return null (treated as "first page") so the caller gets
 * a clean result instead of an error.
 *
 * CUIDs are 24-char lowercase base-36 (typically start with 'c'). We accept
 * any 20-32 char alphanumeric string as a permissive sanity check.
 */
function safeCursor(cursor: string | undefined): string | null {
  if (!cursor || typeof cursor !== "string") return null;
  const trimmed = cursor.trim();
  if (trimmed.length < 20 || trimmed.length > 32) return null;
  if (!/^[a-z0-9]+$/i.test(trimmed)) return null;
  return trimmed;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Users — paginated + search (role:manage gated)
// ---------------------------------------------------------------------------

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarColor: string;
  createdAt: string;
  managerId: string | null;
  managerName: string | null;
}

export async function getUsersPage(input?: {
  cursor?: string;
  limit?: number;
  search?: string;
}): Promise<ActionResult<PaginatedResult<UserListItem>>> {
  return toResult(async () => {
    const cursor = safeCursor(input?.cursor);
    await requirePermission("role:manage");
    const limit = clampLimit(input?.limit);
    const search = input?.search?.trim().toLowerCase();

    const where: Record<string, unknown> = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    const rows = await db.user.findMany({
      where,
      select: {
        id: true, email: true, name: true, role: true, avatarColor: true, createdAt: true,
        managerId: true,
        manager: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return {
      items: items.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        avatarColor: u.avatarColor,
        createdAt: u.createdAt.toISOString(),
        managerId: u.managerId,
        managerName: u.manager?.name ?? null,
      })),
      nextCursor,
      hasMore,
    };
  });
}

// ---------------------------------------------------------------------------
// Tasks — paginated + search (any signed-in user)
// ---------------------------------------------------------------------------

export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  tag: string;
  dueDate: string | null;
  projectId: string | null;
  projectName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  createdAt: string;
}

export async function getTasksPage(input?: {
  cursor?: string;
  limit?: number;
  search?: string;
  projectId?: string;
  status?: string;
}): Promise<ActionResult<PaginatedResult<TaskListItem>>> {
  return toResult(async () => {
    const cursor = safeCursor(input?.cursor);
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    const limit = clampLimit(input?.limit);
    const search = input?.search?.trim().toLowerCase();

    // Deep-dive review F-03 — apply the SAME data scoping as the dashboard
    // loader: MEMBER/MANAGER only see tasks in projects they own / are
    // assigned to / have tasks in (plus tasks assigned to them anywhere).
    // Previously this action returned every task in the workspace to any
    // signed-in user, quietly bypassing the dashboard's scoping.
    const scopedIds = await getScopedProjectIds(auth);

    const conditions: Record<string, unknown>[] = [];
    if (scopedIds) {
      conditions.push({
        OR: [
          { projectId: { in: Array.from(scopedIds) } },
          { assignee: { userId: auth.userId } },
        ],
      });
    }
    if (search) {
      conditions.push({
        OR: [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ],
      });
    }
    const where: Record<string, unknown> = {
      project: { deletedAt: null }, // L-P0-14 soft-delete filter
      ...(conditions.length ? { AND: conditions } : {}),
    };
    if (input?.projectId) where.projectId = input.projectId;
    if (input?.status) where.status = input.status;

    const rows = await db.task.findMany({
      where,
      select: {
        id: true, title: true, status: true, priority: true, tag: true,
        dueDate: true, projectId: true, assigneeId: true, createdAt: true,
        project: { select: { name: true } },
        assignee: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return {
      items: items.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        tag: t.tag,
        dueDate: t.dueDate?.toISOString() ?? null,
        projectId: t.projectId,
        projectName: t.project?.name ?? null,
        assigneeId: t.assigneeId,
        assigneeName: t.assignee?.name ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  });
}

// ---------------------------------------------------------------------------
// Projects — paginated + search (any signed-in user)
// ---------------------------------------------------------------------------

export interface ProjectListItem {
  id: string;
  name: string;
  status: string;
  priority: string;
  dueDate: string | null;
  progress: number;
  color: string;
  ownerName: string;
  createdAt: string;
}

export async function getProjectsPage(input?: {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: string;
}): Promise<ActionResult<PaginatedResult<ProjectListItem>>> {
  return toResult(async () => {
    const cursor = safeCursor(input?.cursor);
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    const limit = clampLimit(input?.limit);
    const search = input?.search?.trim().toLowerCase();

    // Deep-dive review F-03 — same scoping as getDashboardData: scoped roles
    // only see projects they own / are assigned to / have tasks in.
    const scopedIds = await getScopedProjectIds(auth);

    const where: Record<string, unknown> = { deletedAt: null }; // L-P0-14
    if (scopedIds) where.id = { in: Array.from(scopedIds) };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }
    if (input?.status) where.status = input.status;

    const rows = await db.project.findMany({
      where,
      select: {
        id: true, name: true, status: true, priority: true, dueDate: true,
        progress: true, color: true, ownerName: true, createdAt: true,
      },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return {
      items: items.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        priority: p.priority,
        dueDate: p.dueDate?.toISOString() ?? null,
        progress: p.progress,
        color: p.color,
        ownerName: p.ownerName,
        createdAt: p.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  });
}

// ---------------------------------------------------------------------------
// Time entries — paginated + search (any signed-in user)
// ---------------------------------------------------------------------------

export interface TimeEntryListItem {
  id: string;
  projectId: string | null;
  projectName: string | null;
  memberId: string | null;
  memberName: string | null;
  date: string;
  hours: number;
  description: string;
  createdAt: string;
}

export async function getTimeEntriesPage(input?: {
  cursor?: string;
  limit?: number;
  search?: string;
  projectId?: string;
  memberId?: string;
}): Promise<ActionResult<PaginatedResult<TimeEntryListItem>>> {
  return toResult(async () => {
    const cursor = safeCursor(input?.cursor);
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");
    const limit = clampLimit(input?.limit);
    const search = input?.search?.trim().toLowerCase();

    // PR-53 — align the time-entries scope with getDashboardData. The
    // dashboard uses a member-visibility rule (scoped users see entries
    // only for members they can already see: members of their projects +
    // themselves). This action previously used a project-centric rule
    // (`projectId in scoped OR member is me`) which leaked: a non-visible
    // member's entry on a visible project was returned with that member's
    // name — data the dashboard deliberately hides. Now both read paths
    // funnel through getVisibleMemberIds so the scopes can't drift.
    //
    // The caller's `memberId` filter is INTERSECTED with the visible set:
    // a scoped user requesting a member they can't see gets an empty page,
    // not that member's entries. (Previously the filter overwrote the
    // scope entirely, letting any signed-in MEMBER pass `memberId: "m-x"
    // and read member m-x's time logs.)
    const scopedIds = await getScopedProjectIds(auth);
    const visibleMemberIds = await getVisibleMemberIds(auth, scopedIds);

    const where: Record<string, unknown> = { project: { deletedAt: null } };
    if (visibleMemberIds) {
      if (input?.memberId) {
        // Caller wants a specific member — only allow it if that member
        // is visible to the scoped viewer; otherwise return an empty page
        // (not a leak of the requested member's entries).
        if (!visibleMemberIds.has(input.memberId)) {
          return { items: [], nextCursor: null, hasMore: false };
        }
        where.memberId = input.memberId;
      } else {
        where.memberId = { in: Array.from(visibleMemberIds) };
      }
    } else if (input?.memberId) {
      // ADMIN — no member scope; honour the caller's filter directly.
      where.memberId = input.memberId;
    }
    if (search) {
      where.description = { contains: search, mode: "insensitive" };
    }
    if (input?.projectId) where.projectId = input.projectId;

    const rows = await db.timeEntry.findMany({
      where,
      select: {
        id: true, projectId: true, memberId: true, date: true, hours: true,
        description: true, createdAt: true,
        project: { select: { name: true } },
        member: { select: { name: true } },
      },
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return {
      items: items.map((te) => ({
        id: te.id,
        projectId: te.projectId,
        projectName: te.project?.name ?? null,
        memberId: te.memberId,
        memberName: te.member?.name ?? null,
        date: te.date.toISOString(),
        hours: te.hours,
        description: te.description,
        createdAt: te.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  });
}
