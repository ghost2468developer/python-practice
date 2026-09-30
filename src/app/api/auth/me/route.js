import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, tenants, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { json, readJson, requireFields, validationError , route } from "@/lib/http";
import { guard, toTenantShape } from "@/lib/context";
import { listMemberships } from "@/lib/tenancy";
import { serializeUser } from "@/lib/serializers";

export const dynamic = "force-dynamic";

/** GET /api/auth/me/ — current user with every workspace they can reach. */
export const GET = route(async function GET(request) {
  const { user } = await guard(request);
  const workspaces = await listMemberships(user.id);
  return json({
    ...serializeUser(user),
    workspaces: workspaces.map((row) => ({
      ...toTenantShape(row),
      role: row.role,
      is_default: row.isDefault,
      joined_at: row.joinedAt,
    })),
  });
});

/** PATCH /api/auth/me/ — update profile or rotate password. */
export const PATCH = route(async function PATCH(request) {
  const { user } = await guard(request);
  const body = await readJson(request);
  const patch = {};

  if (body.full_name !== undefined) {
    const value = String(body.full_name).trim();
    if (!value || value.length > 120) {
      throw validationError({ full_name: ["Must be between 1 and 120 characters."] });
    }
    patch.fullName = value;
  }

  if (body.new_password !== undefined) {
    const current = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!verifyPassword(String(body.current_password ?? ""), current[0]?.passwordHash ?? "")) {
      throw validationError({ current_password: ["Current password is incorrect."] });
    }
    if (String(body.new_password).length < 8) {
      throw validationError({ new_password: ["Ensure this field has at least 8 characters."] });
    }
    patch.passwordHash = hashPassword(body.new_password);
  }

  if (!Object.keys(patch).length) {
    throw validationError({ non_field_errors: ["Provide full_name or a password change."] });
  }

  const [updated] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning();
  const workspaces = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, user.id))
    .orderBy(asc(memberships.createdAt));

  return json({ ...serializeUser(updated), workspaces });
});
