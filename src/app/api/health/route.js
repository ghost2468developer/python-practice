import { sql } from "drizzle-orm";
import { db } from "@/db";
import { json , route } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = route(async function GET() {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
    return json({
      status: "ok",
      service: "orbit-multi-tenant-pm-api",
      database: "connected",
      latency_ms: Date.now() - startedAt,
      time: new Date().toISOString(),
    });
  } catch (error) {
    return json(
      { status: "degraded", database: "unavailable", detail: String(error?.message ?? error) },
      { status: 503 },
    );
  }
});
