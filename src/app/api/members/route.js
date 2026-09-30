import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { invitations, memberships, tenants, users } from "@/db/schema";
import { randomToken } from "@/lib/auth";
import { badRequest, conflict, json, readJson, requireFields , route } from "@/lib/http";
import { guard } from "@/lib/context";
import { logActivity, ROLES } from "@/lib/tenancy";
import { serializeMembership } from "@/lib/serializers";

export const dynamic = "force-dynamic";

const memberSelect = {
  id: memberships.id,
  role: memberships.role,
  isDefault: memberships.isDefault,
  createdAt: memberships.createdAt,
  userId: users.id,
  userEmail: users.email,
  userFullName: users.fullName,
};

/** GET /api/members/ - roster of the active workspace. */
export const GET = route(async function GET(request) {
  const { tenantId } = await guard(request);
  const rows = await db
    .select(memberSelect)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId))
    .orderBy(asc(memberships.createdAt));

  return json({ count: rows.length, results: rows.map(serializeMembership) });
});

/**
 * POST /api/members/ - invite a teammate (owner/admin).
 * Existing users are added straight away; unknown emails get a pending
 * invitation token which is consumed on first registration.
 */
export const POST = route(async function POST(request) {
  const { user, tenantId } = await guard(request, { roles: ["owner", "admin"] });
  const body = await readJson(request);
  const clean = requireFields(body, {
    email: { type: "string", required: true, maxLength: 254 },
    role: { type: "string", required: false, choices: ROLES, default: "member" },
    full_name: { type: "string", required: false, maxLength: 120 },
  });
  const email = clean.email.toLowerCase();

  if (clean.role === "owner" && user.role !== "owner") {
    throw badRequest("Only workspace owners can grant the owner role.");
  }

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [seatCount] = await db
    .select({ value: sql`count(*)::int` })
    .from(memberships)
    .where(eq(memberships.tenantId, tenantId));
  if (tenant.maxMembers && (seatCount?.value ?? 0) >= tenant.maxMembers) {
    throw conflict(
      `Plan "${tenant.plan}" allows ${tenant.maxMembers} members. Upgrade the workspace to add more seats.`,
    );
  }

  const [existingUser] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existingUser) {
    const existing = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, existingUser.id)))
      .limit(1);
    if (existing.length) {
      throw conflict({ email: ["This user is already a member of the workspace."] });
    }
    const [created] = await db
      .insert(memberships)
      .values({ tenantId, userId: existingUser.id, role: clean.role })
      .returning();
    await logActivity({
      tenantId,
      actorId: user.id,
      verb: "added_member",
      objectType: "membership",
      objectId: created.id,
      summary: `${user.fullName} added ${existingUser.email} as ${clean.role}`,
    });
    return json(
      serializeMembership({ ...created, userEmail: existingUser.email, userFullName: existingUser.fullName, userId: existingUser.id }),
      { status: 201 },
    );
  }

  const alreadyInvited = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.tenantId, tenantId), eq(invitations.email, email)))
    .limit(1);
  if (alreadyInvited.length) {
    throw conflict({ email: ["An invitation for this email is already pending."] });
  }

  const [invite] = await db
    .insert(invitations)
    .values({
      tenantId,
      email,
      role: clean.role,
      token: randomToken(16),
      invitedById: user.id,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    })
    .returning();

  await logActivity({
    tenantId,
    actorId: user.id,
    verb: "invited_member",
    objectType: "invitation",
    objectId: invite.id,
    summary: `${user.fullName} invited ${email} as ${clean.role}`,
  });

  return json(
    {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      status: invite.status,
      token: invite.token,
      expires_at: invite.expiresAt,
      detail: "Invitation created. Ask the teammate to register with this email address.",
    },
    { status: 201 },
  );
});
