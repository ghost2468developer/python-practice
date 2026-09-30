import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { projects, tasks, users } from "@/db/schema";
import { badRequest, conflict, json, parseLimitOffset, paginate, readJson, requireFields , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { logActivity } from "@/lib/tenancy";
import { serializeProject } from "@/lib/serializers";

export const dynamic = "force-dynamic";

const STATUSES = ["planning", "active", "on_hold", "completed", "archived"];
const ORDERINGS = {
  created_at: asc(projects.createdAt),
  "-created_at": desc(projects.createdAt),
  name: asc(projects.name),
  "-name": desc(projects.name),
  due_date: asc(projects.dueDate),
  "-due_date": desc(projects.dueDate),
};

function keyFromName(name) {
  const letters = String(name).replace(/[^a-zA-Z0-9 ]/g, "").trim();
  const words = letters.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words.map((w) => w[0]).join("").toUpperCase().slice(0, 5);
  }
  return letters.slice(0, 4).toUpperCase() || "PRJ";
}

/** GET /api/projects/ — tenant scoped, filterable, paginated. */
export const GET = route(async function GET(request) {
  const { tenantId } = await guard(request);
  const url = new URL(request.url);
  const { limit, offset } = parseLimitOffset(request);
  const status = url.searchParams.get("status");
  const search = url.searchParams.get("search");
  const includeArchived = url.searchParams.get("archived") !== "false";
  const ordering = ORDERINGS[url.searchParams.get("ordering")] ?? desc(projects.createdAt);

  const filters = [eq(projects.tenantId, tenantId)];
  if (status) {
    if (!STATUSES.includes(status)) return json({ status: [`"${status}" is not a valid choice.`] }, { status: 400 });
    filters.push(eq(projects.status, status));
  }
  if (!includeArchived) filters.push(eq(projects.isArchived, false));
  if (search) {
    const term = `%${search}%`;
    const clause = or(ilike(projects.name, term), ilike(projects.key, term), ilike(projects.description, term));
    if (clause) filters.push(clause);
  }

  const where = and(...filters);
  const rows = await db
    .select({
      project: projects,
      ownerEmail: users.email,
      ownerName: users.fullName,
      total: sql`(select count(*)::int from ${tasks} where ${tasks.projectId} = ${projects.id})`,
      open: sql`(select count(*)::int from ${tasks} where ${tasks.projectId} = ${projects.id} and ${tasks.status} <> 'done')`,
    })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.ownerId))
    .where(where)
    .orderBy(ordering)
    .limit(limit)
    .offset(offset);

  const [count] = await db.select({ value: sql`count(*)::int` }).from(projects).where(where);

  return json(
    paginate(
      rows.map((row) =>
        serializeProject({
          ...row.project,
          owner: row.ownerEmail ? { id: row.project.ownerId, email: row.ownerEmail, fullName: row.ownerName } : null,
          totalTaskCount: row.total,
          openTaskCount: row.open,
        }),
      ),
      count?.value ?? 0,
      { limit, offset },
      request.url,
    ),
  );
});

/** POST /api/projects/ — plan quota + per-tenant unique key enforcement. */
export const POST = route(async function POST(request) {
  const { user, tenantId, tenant, role } = await guard(request, { roles: ["owner", "admin", "member"] });
  const body = await readJson(request);
  const clean = requireFields(body, {
    name: { type: "string", required: true, maxLength: 120 },
    key: { type: "string", required: false, maxLength: 10 },
    description: { type: "string", required: false, default: "" },
    status: { type: "string", required: false, choices: STATUSES, default: "planning" },
    color: { type: "string", required: false, maxLength: 9, default: "#6366f1" },
  });

  if (tenant.max_projects) {
    const [count] = await db
      .select({ value: sql`count(*)::int` })
      .from(projects)
      .where(eq(projects.tenantId, tenantId));
    if ((count?.value ?? 0) >= tenant.max_projects) {
      throw conflict(
        `Plan "${tenant.plan}" allows ${tenant.max_projects} projects. Upgrade the workspace to add more.`,
      );
    }
  }

  let key = (clean.key || keyFromName(clean.name)).toUpperCase();
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.key, key)))
    .limit(1);
  if (existing.length) {
    throw conflict({ key: ["Project keys must be unique inside a workspace."] });
  }

  if (body.owner_id) {
    const member = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, body.owner_id))
      .limit(1);
    if (!member.length) throw badRequest({ owner_id: ["User is not a member of this workspace."] });
  }

  const [created] = await db
    .insert(projects)
    .values({
      tenantId,
      name: clean.name,
      key,
      description: clean.description,
      status: clean.status,
      color: clean.color,
      ownerId: body.owner_id ?? user.id,
      dueDate: body.due_date ? new Date(body.due_date) : null,
    })
    .returning();

  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "created_project",
    objectType: "project",
    objectId: created.id,
    summary: `${user.fullName} created the ${role === "viewer" ? "project" : "project"} ${created.name}`,
    metadata: { key: created.key },
  });

  return json(serializeProject({ ...created, owner: { id: user.id, email: user.email, fullName: user.fullName } }), {
    status: 201,
  });
});
