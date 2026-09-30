import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, projects, tasks, users } from "@/db/schema";
import {
  badRequest,
  json,
  notFound,
  parseLimitOffset,
  paginate,
  readJson,
  requireUuid,
  validationError,
} from "@/lib/http";
import { guard } from "@/lib/context";
import { logActivity } from "@/lib/tenancy";
import { serializeProject, serializeTask, userStub } from "@/lib/serializers";

export const dynamic = "force-dynamic";

const STATUSES = ["planning", "active", "on_hold", "completed", "archived"];

async function loadProject(id, tenantId) {
  const [row] = await db
    .select({
      project: projects,
      ownerEmail: users.email,
      ownerName: users.fullName,
    })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.ownerId))
    .where(and(eq(projects.id, id), eq(projects.tenantId, tenantId)))
    .limit(1);
  if (!row) throw notFound("No project matches the given query in this workspace.");
  return {
    ...row.project,
    owner: row.ownerEmail ? { id: row.project.ownerId, email: row.ownerEmail, fullName: row.ownerName } : null,
  };
}

/** GET /api/projects/{id}/ — detail with board columns + recent tasks. */
import { route } from "@/lib/http";
export const GET = route(async function GET(request, ctx) {
  const { tenantId } = await guard(request);
  const { id } = await ctx.params;
  requireUuid(id);
  const project = await loadProject(id, tenantId);

  const [stats] = await db
    .select({
      total: sql`count(*)::int`,
      open: sql`count(*) filter (where ${tasks.status} <> 'done')::int`,
      done: sql`count(*) filter (where ${tasks.status} = 'done')::int`,
      points: sql`coalesce(sum(${tasks.storyPoints}), 0)::int`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, project.id));

  const url = new URL(request.url);
  const { limit, offset } = parseLimitOffset(request, 10);
  const recent = await db
    .select({ task: tasks, assigneeEmail: users.email, assigneeName: users.fullName })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(eq(tasks.projectId, project.id))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)
    .offset(offset);

  return json({
    ...serializeProject(project),
    stats: {
      total_tasks: stats?.total ?? 0,
      open_tasks: stats?.open ?? 0,
      done_tasks: stats?.done ?? 0,
      story_points: stats?.points ?? 0,
    },
    recent_tasks: recent.map((row) =>
      serializeTask({
        ...row.task,
        projectName: project.name,
        projectKey: project.key,
        assignee: row.assigneeEmail
          ? { id: row.task.assigneeId, email: row.assigneeEmail, fullName: row.assigneeName }
          : null,
      }),
    ),
  });
});

/** PATCH /api/projects/{id}/ — members and above. */
export const PATCH = route(async function PATCH(request, ctx) {
  const { user, tenantId } = await guard(request, { roles: ["owner", "admin", "member"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const project = await loadProject(id, tenantId);
  const body = await readJson(request);
  const patch = {};

  if (body.name !== undefined) {
    const value = String(body.name).trim();
    if (!value || value.length > 120) throw validationError({ name: ["Must be 1-120 characters."] });
    patch.name = value;
  }
  if (body.description !== undefined) patch.description = String(body.description);
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw validationError({ status: [`"${body.status}" is not a valid choice.`] });
    patch.status = body.status;
  }
  if (body.color !== undefined) patch.color = String(body.color).slice(0, 9);
  if (body.is_archived !== undefined) patch.isArchived = Boolean(body.is_archived);
  if (body.due_date !== undefined) patch.dueDate = body.due_date ? new Date(body.due_date) : null;
  if (body.owner_id !== undefined) {
    if (body.owner_id) {
      const [member] = await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, body.owner_id)))
        .limit(1);
      if (!member) throw badRequest({ owner_id: ["User is not a member of this workspace."] });
    }
    patch.ownerId = body.owner_id || null;
  }
  if (!Object.keys(patch).length) throw validationError({ non_field_errors: ["No valid fields supplied."] });

  const [updated] = await db
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, project.id))
    .returning();

  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "updated_project",
    objectType: "project",
    objectId: updated.id,
    summary: `${user.fullName} updated project ${updated.name}`,
    metadata: { fields: Object.keys(patch) },
  });

  return json(serializeProject({ ...updated, owner: project.owner }));
});

/** DELETE /api/projects/{id}/ — admin and above (tasks cascade). */
export const DELETE = route(async function DELETE(request, ctx) {
  const { user, tenantId } = await guard(request, { roles: ["owner", "admin"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const project = await loadProject(id, tenantId);
  await db.delete(projects).where(eq(projects.id, project.id));
  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "deleted_project",
    objectType: "project",
    objectId: null,
    summary: `${user.fullName} deleted project ${project.name}`,
  });
  return json({ detail: `Project "${project.name}" was deleted.` });
});


