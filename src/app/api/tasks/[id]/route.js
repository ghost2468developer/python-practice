import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, projects, tasks, users } from "@/db/schema";
import { badRequest, json, notFound, readJson, requireUuid, validationError , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { logActivity } from "@/lib/tenancy";
import { serializeTask } from "@/lib/serializers";

export const dynamic = "force-dynamic";

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

async function loadTask(id, tenantId) {
  const [row] = await db
    .select({
      task: tasks,
      projectKey: projects.key,
      projectName: projects.name,
      assigneeEmail: users.email,
      assigneeName: users.fullName,
    })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)))
    .limit(1);
  if (!row) throw notFound("No task matches the given query in this workspace.");
  return {
    ...row.task,
    projectName: row.projectName,
    projectKey: row.projectKey,
    assignee: row.assigneeEmail
      ? { id: row.task.assigneeId, email: row.assigneeEmail, fullName: row.assigneeName }
      : null,
  };
}

/** GET /api/tasks/{id}/ */
export const GET = route(async function GET(request, ctx) {
  const { tenantId } = await guard(request);
  const { id } = await ctx.params;
  requireUuid(id);
  return json(serializeTask(await loadTask(id, tenantId)));
});

/** PATCH /api/tasks/{id}/ — partial update, DRF ModelViewSet semantics. */
export const PATCH = route(async function PATCH(request, ctx) {
  const { user, tenantId } = await guard(request, { roles: ["owner", "admin", "member"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const task = await loadTask(id, tenantId);
  const body = await readJson(request);
  const patch = { updatedAt: new Date() };

  if (body.title !== undefined) {
    const value = String(body.title).trim();
    if (!value || value.length > 200) throw validationError({ title: ["Must be 1-200 characters."] });
    patch.title = value;
  }
  if (body.description !== undefined) patch.description = String(body.description);
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw validationError({ status: [`"${body.status}" is not a valid choice.`] });
    patch.status = body.status;
    patch.completedAt = body.status === "done" ? (task.completedAt ?? new Date()) : null;
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(body.priority)) {
      throw validationError({ priority: [`"${body.priority}" is not a valid choice.`] });
    }
    patch.priority = body.priority;
  }
  if (body.story_points !== undefined) patch.storyPoints = Number(body.story_points) || 0;
  if (body.due_date !== undefined) patch.dueDate = body.due_date ? new Date(body.due_date) : null;
  if (body.project_id !== undefined) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, body.project_id), eq(projects.tenantId, tenantId)))
      .limit(1);
    if (!project) throw badRequest({ project_id: ["Project does not exist in this workspace."] });
    patch.projectId = body.project_id;
  }
  if (body.assignee_id !== undefined) {
    if (!body.assignee_id) {
      patch.assigneeId = null;
    } else {
      const [member] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, body.assignee_id)))
        .limit(1);
      if (!member) throw badRequest({ assignee_id: ["Assignee must be a member of this workspace."] });
      patch.assigneeId = body.assignee_id;
    }
  }

  const [updated] = await db.update(tasks).set(patch).where(eq(tasks.id, task.id)).returning();

  const changed = Object.keys(patch).filter((key) => key !== "updatedAt");
  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "updated_task",
    objectType: "task",
    objectId: updated.id,
    summary: `${user.fullName} updated ${task.projectKey}-${updated.sequence} (${changed.join(", ")})`,
    metadata: { fields: changed },
  });

  return json(serializeTask(await loadTask(updated.id, tenantId)));
});

/** DELETE /api/tasks/{id}/ — members and above. */
export const DELETE = route(async function DELETE(request, ctx) {
  const { user, tenantId } = await guard(request, { roles: ["owner", "admin", "member"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const task = await loadTask(id, tenantId);
  await db.delete(tasks).where(eq(tasks.id, task.id));
  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "deleted_task",
    objectType: "task",
    objectId: null,
    summary: `${user.fullName} deleted task "${task.title}"`,
  });
  return json({ detail: `Task "${task.title}" was deleted.` });
});
