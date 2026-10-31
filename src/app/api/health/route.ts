import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Health & readiness endpoint — closes L-P0-4.
//
// Performs ONE cheap DB round trip (SELECT 1 via Prisma's $queryRaw) and
// returns 200 OK when the DB responds, 503 when it doesn't. Load balancers
// and orchestrators probe this to distinguish healthy instances from wedged
// ones (the old /api returned "Hello world").
//
// `/api/health`        — liveness + readiness (DB checked)
// `/api/health?ready=1`— same; kept for orchestrators that want a distinct URL
//
// The query is wrapped in Promise.race with a 2s timeout so a wedged DB
// pool can't hang the probe indefinitely (LBs typically time out at 5s).
// ---------------------------------------------------------------------------

const DB_PROBE_TIMEOUT_MS = 2_000;

async function probeDb(): Promise<boolean> {
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db probe timeout")), DB_PROBE_TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch (err) {
    console.error("[health] DB probe failed:", err);
    return false;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const readiness = url.searchParams.get("ready") === "1";

  const dbUp = await probeDb();
  const ok = dbUp;

  const body = {
    status: ok ? "ok" : "down",
    db: dbUp ? "up" : "down",
    readiness,
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: ok ? 200 : 503,
    headers: {
      // No caching — LBs must always get a fresh probe.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
