import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityEvents, users } from "@/db/schema";
import { json, parseLimitOffset, paginate , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { serializeActivity } from "@/lib/serializers";

export const dynamic = "force-dynamic";

/**
 * GET /api/activity/ - tenant scoped audit trail. Because every row carries a
 * tenant_id, one query is all it takes to keep workspaces isolated.
 */
export const GET = route(async function GET(request) {
  const { tenantId } = await guard(request);
  const { limit, offset } = parseLimitOffset(request, 25);
  const where = eq(activityEvents.tenantId, tenantId);

  const rows = await db
    .select({ event: activityEvents, actorEmail: users.email, actorName: users.fullName })
    .from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.actorId))
    .where(where)
    .orderBy(desc(activityEvents.createdAt))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ value: sql`count(*)::int` }).from(activityEvents).where(where);

  return json(
    paginate(
      rows.map((row) =>
        serializeActivity({
          ...row.event,
          actor: row.actorEmail
            ? { id: row.event.actorId, email: row.actorEmail, fullName: row.actorName }
            : null,
        }),
      ),
      count?.value ?? 0,
      { limit, offset },
      request.url,
    ),
  );
});
