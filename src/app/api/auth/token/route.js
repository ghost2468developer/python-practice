import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, tenants, users } from "@/db/schema";
import { asc } from "drizzle-orm";
import { createAccessToken, createRefreshToken, verifyPassword } from "@/lib/auth";
import { json, readJson, requireFields, unauthorized , route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/token/
 * Custom SimpleJWT TokenObtainPairView that embeds the active workspace and
 * role into the access token claims.
 */
export const POST = route(async function POST(request) {
  const body = await readJson(request);
  const clean = requireFields(body, {
    email: { type: "string", required: true, maxLength: 254 },
    password: { type: "string", required: true },
  });

  const email = clean.email.toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !verifyPassword(clean.password, user.passwordHash)) {
    throw unauthorized("No active account found with the given credentials.");
  }
  if (!user.isActive) throw unauthorized("User account is disabled.");

  const rows = await db
    .select({
      tenantId: tenants.id,
      tenantSlug: tenants.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, user.id))
    .orderBy(asc(memberships.createdAt))
    .limit(1);

  const active = rows[0] ?? null;
  const access = createAccessToken(user, active);
  const refresh = createRefreshToken(user, active);

  return json({
    access,
    refresh,
    user: {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
      active_workspace: active ? { id: active.tenantId, slug: active.tenantSlug, role: active.role } : null,
    },
  });
});
