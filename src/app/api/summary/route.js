import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityEvents, memberships, projects, tasks, users } from "@/db/schema";
import { json , route } from "@/lib/http";
import { guard } from "@/lib/context";

export const dynamic = "force-dynamic";

/** GET /api/summary/ - aggregated dashboard metrics for the active workspace. */
export const GET = route(async function GET(request) {
  const { user, tenantId, role, tenant } = await guard(request);

  const [projectStats] = await db
    .select({
      total: sql`count(*)::int`,
      active: sql`count(*) filter (where ${projects.status} = 'active')::int`,
    })
    .from(projects)
    .where(eq(projects.tenantId, tenantId));

  const statusRows = await db
    .select({ status: tasks.status, value: sql`count(*)::int` })
    .from(tasks)
    .where(eq(tasks.tenantId, tenantId))
    .groupBy(tasks.status);

  const priorityRows = await db
    .select({ priority: tasks.priority, value: sql`count(*)::int` })
    .from(tasks)
    .where(eq(tasks.tenantId, tenantId))
    .groupBy(tasks.priority);

  const perProject = await db
    .select({
      id: projects.id,
      name: projects.name,
      key: projects.key,
      color: projects.color,
      total: sql`count(${tasks.id})::int`,
      done: sql`count(${tasks.id}) filter (where ${tasks.status} = 'done')::int`,
      points: sql`coalesce(sum(${tasks.storyPoints}), 0)::int`,
    })
    .from(projects)
    .leftJoin(tasks, eq(tasks.projectId, projects.id))
    .where(eq(projects.tenantId, tenantId))
    .groupBy(projects.id, projects.name, projects.key, projects.color)
    .orderBy(projects.name);

  const [memberStats] = await db
    .select({ total: sql`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));

  const [mine] = await db
    .select({ value: sql`count(*)::int` })
    .from(tasks)
    .where(sql`${tasks.tenantId} = ${tenantId} and ${tasks.assigneeId} = ${user.id} and ${tasks.status} <> 'done'`);

  const board = await db
    .select({ assignee: users.fullName, value: sql`count(*)::int` })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.assigneeId))
    .where(eq(tasks.tenantId, tenantId))
    .groupBy(users.fullName)
    .orderBy(desc(sql`count(*)`))
    .limit(6);

  const recent = await db
    .select({ event: activityEvents, actorName: users.fullName })
    .from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.actorId))
    .where(eq(activityEvents.tenantId, tenantId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(6);

  const totalTasks = statusRows.reduce((sum, row) => sum + row.value, 0);
  const done = statusRows.find((row) => row.status === "done")?.value ?? 0;

  return json({
    workspace: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan },
    me: { id: user.id, full_name: user.fullName, role },
    totals: {
      projects: projectStats?.total ?? 0,
      active_projects: projectStats?.active ?? 0,
      members: memberStats?.total ?? 0,
      tasks: totalTasks,
      open_tasks: totalTasks - done,
      completed_tasks: done,
      my_open_tasks: mine?.value ?? 0,
      completion_rate: totalTasks ? Math.round((done / totalTasks) * 100) : 0,
    },
    by_status: Object.fromEntries(statusRows.map((row) => [row.status, row.value])),
    by_priority: Object.fromEntries(priorityRows.map((row) => [row.priority, row.value])),
    projects: perProject.map((row) => ({
      ...row,
      progress: row.total ? Math.round((row.done / row.total) * 100) : 0,
    })),
    workload: board,
    recent_activity: recent.map((row) => ({
      id: row.event.id,
      summary: row.event.summary,
      verb: row.event.verb,
      created_at: row.event.createdAt,
      actor: row.actorName,
    })),
  });
});
