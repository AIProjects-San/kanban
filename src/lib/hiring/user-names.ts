// Shared display-name lookup for the hiring surfaces (board, outbox,
// formalities, offers) — one query shape, joined in memory.

import { db } from "@/lib/infra/db";

export async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}
