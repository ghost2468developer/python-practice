import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, users } from "@/db/schema";
import { badRequest, json, notFound, readJson, requireUuid, validationError , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { ROLES, logActivity } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

async function loadMembership(membershipId, tenantId) {
  const [row] = await db
    .select({
      id: memberships.id,
      role: memberships.role,
      isDefault: memberships.isDefault,
      createdAt: memberships.createdAt,
      userId: users.id,
      userEmail: users.email,
      userFullName: users.fullName,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenantId)))
    .limit(1);
  if (!row) throw notFound("No membership matches the given query.");
  return row;
}

/** PATCH /api/members/{id}/ - change a teammate's workspace role. */
export const PATCH = route(async function PATCH(request, ctx) {
  const { user, role: actorRole, tenantId } = await guard(request, { roles: ["owner", "admin"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const membership = await loadMembership(id, tenantId);
  const body = await readJson(request);

  const nextRole = body.role;
  if (!nextRole || !ROLES.includes(nextRole)) {
    throw validationError({ role: [`"${nextRole ?? ""}" is not a valid choice.`] });
  }
  if (nextRole === "owner" && actorRole !== "owner") {
    throw badRequest("Only workspace owners can grant the owner role.");
  }
  if (membership.role === "owner" && nextRole !== "owner" && actorRole !== "owner") {
    throw badRequest("Admins cannot change the role of an owner.");
  }
  if (membership.userId === user.id && nextRole !== "owner") {
    const [owners] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, "owner")));
    if (owners && owners.id === membership.id) {
      throw badRequest("You cannot demote yourself - the workspace needs another owner first.");
    }
  }

  const [updated] = await db
    .update(memberships)
    .set({ role: nextRole })
    .where(eq(memberships.id, membership.id))
    .returning();

  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "changed_role",
    objectType: "membership",
    objectId: updated.id,
    summary: `${user.fullName} set ${membership.userEmail} to ${nextRole}`,
    metadata: { from: membership.role, to: nextRole },
  });

  return json({
    id: updated.id,
    role: updated.role,
    is_default: updated.isDefault,
    joined_at: updated.createdAt,
    user: { id: membership.userId, email: membership.userEmail, full_name: membership.userFullName },
  });
});

/** DELETE /api/members/{id}/ - revoke a teammate's access. */
export const DELETE = route(async function DELETE(request, ctx) {
  const { user, role: actorRole, tenantId } = await guard(request, { roles: ["owner", "admin"] });
  const { id } = await ctx.params;
  requireUuid(id);
  const membership = await loadMembership(id, tenantId);

  if (membership.role === "owner" && actorRole !== "owner") {
    throw badRequest("Admins cannot remove an owner.");
  }
  if (membership.userId === user.id) {
    throw badRequest("Use DELETE /api/tenants/{id}/ to leave, or ask another owner to remove you.");
  }

  await db.delete(memberships).where(eq(memberships.id, membership.id));
  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "removed_member",
    objectType: "membership",
    objectId: membership.id,
    summary: `${user.fullName} removed ${membership.userEmail}`,
  });

  return json({ detail: `${membership.userEmail} no longer has access to this workspace.` }, { status: 200 });
});
