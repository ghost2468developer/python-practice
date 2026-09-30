import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { memberships, tenants } from "@/db/schema";
import { slugify } from "@/lib/auth";
import { json, readJson, requireFields , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { listMemberships, logActivity, PLAN_LIMITS } from "@/lib/tenancy";
import { serializeTenant } from "@/lib/serializers";

export const dynamic = "force-dynamic";

/** GET /api/tenants/ — every workspace the authenticated user belongs to. */
export const GET = route(async function GET(request) {
  const { user } = await guard(request);
  const rows = await listMemberships(user.id);
  return json({
    count: rows.length,
    results: rows.map((row) => ({
      ...serializeTenant({ ...row, settings: {}, createdAt: row.joinedAt }),
      role: row.role,
      is_default: row.isDefault,
      membership_id: row.membershipId,
    })),
  });
});

/** POST /api/tenants/ — create an additional workspace (multi-tenant sign-up). */
export const POST = route(async function POST(request) {
  const { user } = await guard(request);
  const body = await readJson(request);
  const clean = requireFields(body, {
    name: { type: "string", required: true, maxLength: 120 },
    plan: { type: "string", required: false, choices: Object.keys(PLAN_LIMITS), default: "free" },
  });

  const limits = PLAN_LIMITS[clean.plan] ?? PLAN_LIMITS.free;
  let slug = slugify(clean.name) || `workspace-${Date.now().toString(36)}`;
  const clash = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (clash.length) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: clean.name,
      slug,
      plan: clean.plan,
      billingEmail: user.email,
      maxProjects: limits.maxProjects ?? 1000,
      maxMembers: limits.maxMembers ?? 1000,
    })
    .returning();

  await db.insert(memberships).values({
    tenantId: tenant.id,
    userId: user.id,
    role: "owner",
    isDefault: false,
  });

  await logActivity({
    tenantId: tenant.id,
    actorId: user.id,
    verb: "created",
    objectType: "tenant",
    objectId: tenant.id,
    summary: `${user.fullName} created the workspace ${tenant.name}`,
  });

  return json(serializeTenant(tenant), { status: 201 });
});

/** Helper shared with sibling routes for seat/project quota checks. */
export const tenantUsage = route(async function tenantUsage(tenantId) {
  const [projectCount] = await db
    .select({ value: sql`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));
  return { members: projectCount?.value ?? 0 };
});
