import { NextResponse } from "next/server";
import { APP } from "@/config/app";

// Root API surface. The old "Hello world" placeholder was flagged by the
// launch readiness audit (§9.4 L-P0-4) as a missing health probe. The real
// health endpoint now lives at /api/health (DB-checked, 503 on failure).
export async function GET() {
  return NextResponse.json({
    name: `${APP.name} API`,
    health: "/api/health",
    docs: "/docs",
  });
}
