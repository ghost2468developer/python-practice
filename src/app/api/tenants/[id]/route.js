import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, projects, tasks, tenants } from "@/db/schema";
import { badRequest, json, notFound, readJson, requireUuid, validationError , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { logActivity, PLAN_LIMITS } from "@/lib/tenancy";
import { serializeTenant } from "@/lib/serializers";

export const dynamic = "force-dynamic";

async function loadTenant(id) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  if (!tenant) throw notFound("No workspace matches the given query.");
  return tenant;
}

/** GET /api/tenants/{id}/ — workspace detail + usage statistics. */
export const GET = route(async function GET(request, ctx) {
  const { tenantId, role } = await guard(request);
  const { id } = await ctx.params;
  requireUuid(id);
  const tenant = await loadTenant(id);
  if (tenant.id !== tenantId) throw notFound("No workspace matches the given query.");

  const [projectStats] = await db
    .select({
      total: sql`count(*)::int`,
      active: sql`count(*) filter (where ${projects.status} = 'active')::int`,
    })
    .from(projects)
    .where(eq(projects.tenantId, tenantId));

  const [memberStats] = await db
    .select({ total: sql`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));

  const [taskStats] = await db
    .select({
      total: sql`count(*)::int`,
      open: sql`count(*) filter (where ${tasks.status} <> 'done')::int`,
      done: sql`count(*) filter (where ${tasks.status} = 'done')::int`,
    })
    .from(tasks)
    .where(eq(tasks.tenantId, tenantId));

  return json({
    ...serializeTenant(tenant),
    role,
    usage: {
      projects: projectStats?.total ?? 0,
      active_projects: projectStats?.active ?? 0,
      members: memberStats?.total ?? 0,
      tasks: taskStats?.total ?? 0,
      open_tasks: taskStats?.open ?? 0,
      completed_tasks: taskStats?.done ?? 0,
    },
  });
});

/** PATCH /api/tenants/{id}/ — owner/admin workspace settings. */
export const PATCH = route(async function PATCH(request, ctx) {
  const { user, role, tenantId } = await guard(request, { roles: ["owner", "admin"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const tenant = await loadTenant(id);
  if (tenant.id !== tenantId) throw notFound("No workspace matches the given query.");

  const body = await readJson(request);
  const patch = {};

  if (body.name !== undefined) {
    const value = String(body.name).trim();
    if (!value || value.length > 120) throw validationError({ name: ["Must be 1-120 characters."] });
    patch.name = value;
  }
  if (body.billing_email !== undefined) patch.billingEmail = body.billing_email;
  if (body.settings !== undefined) {
    if (typeof body.settings !== "object") throw validationError({ settings: ["Must be an object."] });
    patch.settings = body.settings;
  }
  if (body.plan !== undefined) {
    if (!PLAN_LIMITS[body.plan]) throw validationError({ plan: [`"${body.plan}" is not a valid choice.`] });
    if (body.plan !== tenant.plan && role !== "owner") {
      throw badRequest("Only workspace owners can change the subscription plan.");
    }
    const limits = PLAN_LIMITS[body.plan];
    patch.plan = body.plan;
    patch.maxProjects = limits.maxProjects ?? 1000;
    patch.maxMembers = limits.maxMembers ?? 1000;
  }

  if (!Object.keys(patch).length) {
    throw validationError({ non_field_errors: ["No valid fields supplied."] });
  }

  const [updated] = await db
    .update(tenants)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tenants.id, tenant.id))
    .returning();

  await logActivity({
    tenantId: tenant.id,
    actorId: user.id,
    verb: "updated",
    objectType: "tenant",
    objectId: tenant.id,
    summary: `${user.fullName} updated workspace settings`,
    metadata: { fields: Object.keys(patch) },
  });

  return json(serializeTenant(updated));
});

/** DELETE /api/tenants/{id}/ — owner only, cascades every workspace record. */
export const DELETE = route(async function DELETE(request, ctx) {
  const { user, role, tenantId } = await guard(request, { roles: ["owner"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const tenant = await loadTenant(id);
  if (tenant.id !== tenantId) throw notFound("No workspace matches the given query.");

  const [owners] = await db
    .select({ value: sql`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.role, "owner")));
  if ((owners?.value ?? 0) <= 1) {
    throw badRequest("A workspace must always keep at least one owner.");
  }

  await db.delete(tenants).where(eq(tenants.id, tenant.id));
  return json({
    detail: `Workspace "${tenant.name}" and all related records were deleted by the ${role}.`,
  });
});
