import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { comments, memberships, projects, tasks, users } from "@/db/schema";
import { badRequest, json, parseLimitOffset, paginate, readJson, requireFields, validationError , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { logActivity } from "@/lib/tenancy";
import { serializeTask } from "@/lib/serializers";

export const dynamic = "force-dynamic";

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const ORDERINGS = {
  created_at: asc(tasks.createdAt),
  "-created_at": desc(tasks.createdAt),
  updated_at: asc(tasks.updatedAt),
  "-updated_at": desc(tasks.updatedAt),
  due_date: asc(tasks.dueDate),
  "-due_date": desc(tasks.dueDate),
  priority: asc(tasks.priority),
  "-priority": desc(tasks.priority),
};

const baseSelect = {
  task: tasks,
  projectKey: projects.key,
  projectName: projects.name,
  assigneeEmail: users.email,
  assigneeName: users.fullName,
};

/**
 * GET /api/tasks/
 * Supports ?project= &status= &priority= &assignee= &search= &ordering= &limit= &offset=
 */
export const GET = route(async function GET(request) {
  const { tenantId } = await guard(request);
  const url = new URL(request.url);
  const { limit, offset } = parseLimitOffset(request);
  const ordering = ORDERINGS[url.searchParams.get("ordering")] ?? desc(tasks.createdAt);

  const filters = [eq(tasks.tenantId, tenantId)];
  const projectId = url.searchParams.get("project");
  if (projectId) {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw validationError({ project: ["Must be a valid UUID."] });
    filters.push(eq(tasks.projectId, projectId));
  }
  const status = url.searchParams.get("status");
  if (status) {
    if (!STATUSES.includes(status)) throw validationError({ status: [`"${status}" is not a valid choice.`] });
    filters.push(eq(tasks.status, status));
  }
  const priority = url.searchParams.get("priority");
  if (priority) {
    if (!PRIORITIES.includes(priority)) throw validationError({ priority: [`"${priority}" is not a valid choice.`] });
    filters.push(eq(tasks.priority, priority));
  }
  const assignee = url.searchParams.get("assignee");
  if (assignee === "me") filters.push(eq(tasks.assigneeId, assigneeIdFrom(request)));
  else if (assignee) filters.push(eq(tasks.assigneeId, assignee));
  else if (assignee === null && url.searchParams.get("unassigned") === "true") {
    filters.push(sql`${tasks.assigneeId} is null`);
  }
  const search = url.searchParams.get("search");
  if (search) {
    const term = `%${search}%`;
    const clause = or(ilike(tasks.title, term), ilike(tasks.description, term));
    if (clause) filters.push(clause);
  }

  const where = and(...filters);
  const rows = await db
    .select(baseSelect)
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .where(where)
    .orderBy(ordering)
    .limit(limit)
    .offset(offset);

  const [count] = await db
    .select({ value: sql`count(*)::int` })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(where);

  const ids = rows.map((row) => row.task.id);
  const commentCounts = ids.length
    ? await db
        .select({ taskId: comments.taskId, value: sql`count(*)::int` })
        .from(comments)
        .where(inArray(comments.taskId, ids))
        .groupBy(comments.taskId)
    : [];
  const countMap = new Map(commentCounts.map((row) => [row.taskId, row.value]));

  return json(
    paginate(
      rows.map((row) =>
        serializeTask({
          ...row.task,
          projectName: row.projectName,
          projectKey: row.projectKey,
          assignee: row.assigneeEmail
            ? { id: row.task.assigneeId, email: row.assigneeEmail, fullName: row.assigneeName }
            : null,
          commentCount: countMap.get(row.task.id) ?? 0,
        }),
      ),
      count?.value ?? 0,
      { limit, offset },
      request.url,
    ),
  );
});



/** POST /api/tasks/ - create a task inside a project of the active workspace. */
export const POST = route(async function POST(request) {
  const { user, tenantId } = await guard(request, { roles: ["owner", "admin", "member"] });
  const body = await readJson(request);
  const clean = requireFields(body, {
    project: { type: "string", required: true },
    title: { type: "string", required: true, maxLength: 200 },
    description: { type: "string", required: false, default: "" },
    status: { type: "string", required: false, choices: STATUSES, default: "todo" },
    priority: { type: "string", required: false, choices: PRIORITIES, default: "medium" },
  });

  const [project] = await db
    .select({ id: projects.id, name: projects.name, key: projects.key })
    .from(projects)
    .where(and(eq(projects.id, clean.project), eq(projects.tenantId, tenantId)))
    .limit(1);
  if (!project) throw badRequest({ project: ["Project does not exist in this workspace."] });

  let assigneeId = null;
  if (body.assignee_id) {
    const [member] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, body.assignee_id)))
      .limit(1);
    if (!member) throw badRequest({ assignee_id: ["Assignee must be a member of this workspace."] });
    assigneeId = body.assignee_id;
  }

  const [maxRow] = await db
    .select({ value: sql`coalesce(max(${tasks.sequence}), 0)::int` })
    .from(tasks)
    .where(eq(tasks.projectId, project.id));

  const [created] = await db
    .insert(tasks)
    .values({
      tenantId,
      projectId: project.id,
      title: clean.title,
      description: clean.description,
      status: clean.status,
      priority: clean.priority,
      assigneeId,
      reporterId: user.id,
      sequence: (maxRow?.value ?? 0) + 1,
      storyPoints: Number.isFinite(Number(body.story_points)) ? Number(body.story_points) : 0,
      dueDate: body.due_date ? new Date(body.due_date) : null,
      completedAt: clean.status === "done" ? new Date() : null,
    })
    .returning();

  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "created_task",
    objectType: "task",
    objectId: created.id,
    summary: `${user.fullName} created ${project.key}-${created.sequence} · ${created.title}`,
    metadata: { project: project.name, status: created.status },
  });

  return json(
    serializeTask({ ...created, projectName: project.name, projectKey: project.key, assignee: assigneeId ? { id: assigneeId } : null }),
    { status: 201 },
  );
});
