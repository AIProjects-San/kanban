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
import { getSession, AuthorizationError } from "./auth-guard";
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

export async function searchWorkspace(query: string): Promise<ActionResult<SearchResults>> {
  return toResult(async () => {
    const auth = await getSession();
    if (!auth) throw new AuthorizationError("You must be signed in.");

    const q = query.trim();
    const empty: SearchResults = { query: q, tasks: [], projects: [], members: [] };
    if (q.length < MIN_QUERY_LENGTH) return empty;

    const contains = { contains: q, mode: "insensitive" as const };

    const [tasks, projects, members] = await Promise.all([
      db.task.findMany({
        where: {
          project: { deletedAt: null }, // L-P0-14 soft-delete filter
          OR: [{ title: contains }, { description: contains }],
        },
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
