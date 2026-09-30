import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberships, projects, tasks, tenants, users } from "@/db/schema";
import { hashPassword, slugify } from "@/lib/auth";
import { conflict, json, readJson, requireFields , route } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register/
 * Creates a user, bootstraps a workspace (tenant) and attaches the creator as
 * `owner` — the SaaS sign-up path.
 */
export const POST = route(async function POST(request) {
  const body = await readJson(request);
  const clean = requireFields(body, {
    full_name: { type: "string", required: true, maxLength: 120 },
    email: { type: "string", required: true, maxLength: 254 },
    password: { type: "string", required: true },
    workspace_name: { type: "string", required: false, maxLength: 120 },
  });

  const email = clean.email.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ email: ["Enter a valid email address."] }, { status: 400 });
  }
  if (String(clean.password).length < 8) {
    return json({ password: ["Ensure this field has at least 8 characters."] }, { status: 400 });
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length) {
    return json({ email: ["A user with that email address already exists."] }, { status: 409 });
  }

  const workspaceName = clean.workspace_name || `${clean.full_name.split(" ")[0]}'s Workspace`;
  const slug = await uniqueSlug(workspaceName);

  const [user] = await db
    .insert(users)
    .values({
      email,
      fullName: clean.full_name,
      passwordHash: hashPassword(clean.password),
    })
    .returning();

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: workspaceName,
      slug,
      plan: "free",
      billingEmail: email,
      maxProjects: 3,
      maxMembers: 5,
    })
    .returning();

  await db.insert(memberships).values({
    tenantId: tenant.id,
    userId: user.id,
    role: "owner",
    isDefault: true,
  });

  const [project] = await db
    .insert(projects)
    .values({
      tenantId: tenant.id,
      name: "Getting started",
      key: "START",
      description: "Your first project. Rename it or archive it whenever you like.",
      status: "active",
      ownerId: user.id,
      color: "#6366f1",
    })
    .returning();

  await db.insert(tasks).values([
    {
      tenantId: tenant.id,
      projectId: project.id,
      title: "Invite your team",
      description: "Workspace owners and admins can invite teammates from POST /api/members/.",
      status: "todo",
      priority: "high",
      reporterId: user.id,
      assigneeId: user.id,
      storyPoints: 2,
    },
    {
      tenantId: tenant.id,
      projectId: project.id,
      title: "Create your first task",
      description: "POST /api/tasks/ with a project id to add work to the backlog.",
      status: "backlog",
      priority: "medium",
      reporterId: user.id,
      storyPoints: 1,
    },
  ]);

  return json(
    {
      id: user.id,
      email: user.email,
      full_name: user.fullName,
      workspace: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan },
      detail: "Account created. Exchange your credentials for a token at /api/auth/token/.",
    },
    { status: 201 },
  );
});

async function uniqueSlug(name) {
  const base = slugify(name) || `workspace-${Date.now().toString(36)}`;
  let candidate = base;
  let suffix = 1;
  for (;;) {
    const taken = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.slug, candidate)))
      .limit(1);
    if (!taken.length) return candidate;
    candidate = `${base}-${++suffix}`.slice(0, 63);
    if (suffix > 50) throw conflict("Could not derive a unique workspace slug.");
  }
}
