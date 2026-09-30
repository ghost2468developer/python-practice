import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { comments, tasks, users } from "@/db/schema";
import { json, notFound, parseLimitOffset, paginate, readJson, requireFields, requireUuid , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { logActivity } from "@/lib/tenancy";
import { serializeComment } from "@/lib/serializers";

export const dynamic = "force-dynamic";

async function loadTask(id, tenantId) {
  const [task] = await db
    .select({ id: tasks.id, title: tasks.title, sequence: tasks.sequence })
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)))
    .limit(1);
  if (!task) throw notFound("No task matches the given query in this workspace.");
  return task;
}

/** GET /api/tasks/{id}/comments/ */
export const GET = route(async function GET(request, ctx) {
  const { tenantId } = await guard(request);
  const { id } = await ctx.params;
  requireUuid(id);
  const task = await loadTask(id, tenantId);
  const { limit, offset } = parseLimitOffset(request, 20);

  const where = eq(comments.taskId, task.id);
  const rows = await db
    .select({ comment: comments, authorEmail: users.email, authorName: users.fullName })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.authorId))
    .where(where)
    .orderBy(asc(comments.createdAt))
    .limit(limit)
    .offset(offset);
  const [count] = await db.select({ value: sql`count(*)::int` }).from(comments).where(where);

  return json(
    paginate(
      rows.map((row) =>
        serializeComment({
          ...row.comment,
          author: row.authorEmail
            ? { id: row.comment.authorId, email: row.authorEmail, fullName: row.authorName }
            : null,
        }),
      ),
      count?.value ?? 0,
      { limit, offset },
      request.url,
    ),
  );
});

/** POST /api/tasks/{id}/comments/ */
export const POST = route(async function POST(request, ctx) {
  const { user, tenantId, role } = await guard(request);
  const { id } = await ctx.params;
  requireUuid(id);
  const task = await loadTask(id, tenantId);
  const body = await readJson(request);
  const clean = requireFields(body, { body: { type: "string", required: true } });
  if (!clean.body.trim()) {
    return json({ body: ["This field may not be blank."] }, { status: 400 });
  }

  const [created] = await db
    .insert(comments)
    .values({ tenantId, taskId: task.id, authorId: user.id, body: clean.body.trim() })
    .returning();

  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, task.id));
  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "commented",
    objectType: "task",
    objectId: task.id,
    summary: `${user.fullName} commented on ${task.title}`,
    metadata: { role },
  });

  return json(
    serializeComment({ ...created, author: { id: user.id, email: user.email, fullName: user.fullName } }),
    { status: 201 },
  );
});
