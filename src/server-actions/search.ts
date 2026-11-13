"use server";

// ---------------------------------------------------------------------------
// L-P2-30 — Global data search.
//
// The audit (§9.6 L-P2-30) found the command palette searched commands only
// — no way to find a task by title, a project by name, or a user by email.
// This action provides a single server-side search across tasks, projects,
// and members, returning grouped results for the palette's new "Search"
// group.
//
// Search is Postgres ILIKE (Prisma mode: "insensitive") over the natural
// text columns. Trigram GIN indexes can be added later if needed at scale
// (the audit's note). Results are capped per group (default 5) so the
// palette stays snappy.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { getSessionOrThrow } from "./auth-guard";
import { getScopedProjectIds } from "./shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";

export interface SearchHit {
  id: string;
  /** Display label (task title / project name / member name). */
  label: string;
  /** Secondary line (project name / status / email). */
  sublabel: string;
  /** Which group the hit belongs to — drives the palette section. */
  kind: "task" | "project" | "member";
}

export interface SearchResults {
  query: string;
  tasks: SearchHit[];
  projects: SearchHit[];
  members: SearchHit[];
}

const PER_GROUP = 5;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100; // Deep-dive review F-03: cap the ILIKE needle.

export async function searchWorkspace(query: string): Promise<ActionResult<SearchResults>> {
  return toResult(async () => {
    const auth = await getSessionOrThrow();

    const q = query.trim().slice(0, MAX_QUERY_LENGTH);
    const empty: SearchResults = { query: q, tasks: [], projects: [], members: [] };
    if (q.length < MIN_QUERY_LENGTH) return empty;

    // Deep-dive review F-03 — apply the SAME scoping as the dashboard loader:
    // MEMBER/MANAGER only search tasks/projects inside projects they own /
    // are assigned to / have tasks in (plus their own tasks anywhere). The
    // member directory group stays unscoped — MEMBERS hold team:view and the
    // roster is the messaging routing surface by design (see getUserByEmail).
    const scopedIds = await getScopedProjectIds(auth);

    const contains = { contains: q, mode: "insensitive" as const };
    const searchOr = [
      { title: contains },
      { description: contains },
    ];
    const taskWhere: Record<string, unknown> =
      scopedIds
        ? {
            project: { deletedAt: null }, // L-P0-14 soft-delete filter
            AND: [
              {
                OR: [
                  { projectId: { in: Array.from(scopedIds) } },
                  { assignee: { userId: auth.userId } },
                ],
              },
              { OR: searchOr },
            ],
          }
        : {
            project: { deletedAt: null }, // L-P0-14 soft-delete filter
            OR: searchOr,
          };

    const [tasks, projects, members] = await Promise.all([
      db.task.findMany({
        where: taskWhere,
        select: {
          id: true, title: true, status: true,
          project: { select: { name: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: PER_GROUP,
      }),
      db.project.findMany({
        where: {
          deletedAt: null, // L-P0-14 soft-delete filter
          ...(scopedIds ? { id: { in: Array.from(scopedIds) } } : {}),
          OR: [{ name: contains }, { description: contains }],
        },
        select: { id: true, name: true, status: true },
        orderBy: { updatedAt: "desc" },
        take: PER_GROUP,
      }),
      db.teamMember.findMany({
        where: {
          deletedAt: null, // L-P0-14 soft-delete filter
          OR: [{ name: contains }, { email: contains }],
        },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { name: "asc" },
        take: PER_GROUP,
      }),
    ]);

    return {
      query: q,
      tasks: tasks.map((t) => ({
        id: t.id,
        label: t.title,
        sublabel: t.project?.name ?? "No project",
        kind: "task" as const,
      })),
      projects: projects.map((p) => ({
        id: p.id,
        label: p.name,
        sublabel: p.status,
        kind: "project" as const,
      })),
      members: members.map((m) => ({
        id: m.id,
        label: m.name,
        sublabel: m.role,
        kind: "member" as const,
      })),
    };
  });
}
