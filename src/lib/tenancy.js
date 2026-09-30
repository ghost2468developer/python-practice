import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { activityEvents, memberships, tenants, users } from "@/db/schema";
import { TokenError, verifyToken } from "./auth";
import { permissionDenied, unauthorized } from "./http";

export const ROLES = ["owner", "admin", "member", "viewer"];
export const ROLE_RANK = { viewer: 1, member: 2, admin: 3, owner: 4 };

export const PLAN_LIMITS = {
  free: { label: "Free", maxProjects: 3, maxMembers: 5 },
  pro: { label: "Pro", maxProjects: 25, maxMembers: 25 },
  business: { label: "Business", maxProjects: null, maxMembers: null },
};

const membershipColumns = {
  membershipId: memberships.id,
  role: memberships.role,
  isDefault: memberships.isDefault,
  joinedAt: memberships.createdAt,
  tenantId: tenants.id,
  tenantName: tenants.name,
  tenantSlug: tenants.slug,
  tenantPlan: tenants.plan,
  maxProjects: tenants.maxProjects,
  maxMembers: tenants.maxMembers,
  billingEmail: tenants.billingEmail,
};

/**
 * TokenAuthentication equivalent: `Authorization: Bearer <access>`.
 * Returns the request user plus the decoded JWT claims.
 */
export async function authenticate(request) {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (!token || scheme.toLowerCase() !== "bearer") {
    throw unauthorized();
  }
  let payload;
  try {
    payload = verifyToken(token, "access");
  } catch (error) {
    if (error instanceof TokenError) throw unauthorized(error.detail);
    throw error;
  }

  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user || !user.isActive) {
    throw unauthorized("User account is disabled.");
  }
  return { user, claims: payload };
}

/**
 * Tenant resolution. A request may target any workspace the user belongs to by
 * sending `X-Tenant-Slug`; otherwise the workspace embedded in the JWT is used.
 */
export async function resolveTenant(user, claims, request) {
  const headerSlug = request.headers.get("x-tenant-slug")?.trim();
  const filters = [eq(memberships.userId, user.id)];
  if (headerSlug) filters.push(eq(tenants.slug, headerSlug));
  else if (claims?.tenant_id) filters.push(eq(tenants.id, claims.tenant_id));

  const rows = await db
    .select(membershipColumns)
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(...filters))
    .orderBy(asc(memberships.createdAt))
    .limit(1);

  if (!rows.length) {
    throw permissionDenied(
      headerSlug
        ? `You are not a member of workspace "${headerSlug}".`
        : "No workspace is associated with this account.",
    );
  }
  return { tenant: rows[0], membership: rows[0] };
}

export function requireRole(membership, allowed) {
  if (!allowed.includes(membership.role)) {
    throw permissionDenied(
      `Requires one of the following roles: ${allowed.join(", ")}. Your role is "${membership.role}".`,
    );
  }
  return true;
}

export function canWrite(role) {
  return ROLE_RANK[role] >= ROLE_RANK.member;
}

export async function logActivity({
  tenantId,
  actorId,
  verb,
  objectType,
  objectId = null,
  summary,
  metadata = {},
}) {
  await db.insert(activityEvents).values({
    tenantId,
    actorId,
    verb,
    objectType,
    objectId,
    summary,
    metadata,
  });
}

export async function listMemberships(userId) {
  return db
    .select(membershipColumns)
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt));
}
