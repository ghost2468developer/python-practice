import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityEvents, comments, memberships, projects, tasks, tenants, users } from "@/db/schema";
import { hashPassword } from "./auth";

export const DEMO_PASSWORD = "demo1234";

const days = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
const hoursAgo = (n) => new Date(Date.now() - n * 60 * 60 * 1000);

const PEOPLE = [
  { email: "ada@orbit.dev", fullName: "Ada Lovelace" },
  { email: "grace@orbit.dev", fullName: "Grace Hopper" },
  { email: "linus@orbit.dev", fullName: "Linus Berg" },
  { email: "margaret@orbit.dev", fullName: "Margaret Hamilton" },
];

/**
 * Idempotent demo dataset: two isolated workspaces that share the same users so
 * tenant isolation can be demonstrated with a single login.
 */
export async function ensureSeed() {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, PEOPLE[0].email))
    .limit(1);
  if (existing.length) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, "northwind-labs")).limit(1);
    return { created: false, email: PEOPLE[0].email, password: DEMO_PASSWORD, tenantSlug: tenant?.slug ?? "northwind-labs" };
  }

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const insertedUsers = await db
    .insert(users)
    .values(PEOPLE.map((person) => ({ ...person, passwordHash })))
    .returning();
  const byEmail = Object.fromEntries(insertedUsers.map((u) => [u.email, u]));
  const ada = byEmail["ada@orbit.dev"];
  const grace = byEmail["grace@orbit.dev"];
  const linus = byEmail["linus@orbit.dev"];
  const margaret = byEmail["margaret@orbit.dev"];

  const [northwind, internal] = await db
    .insert(tenants)
    .values([
      {
        name: "Northwind Labs",
        slug: "northwind-labs",
        plan: "pro",
        billingEmail: ada.email,
        maxProjects: 25,
        maxMembers: 25,
        settings: { timezone: "Europe/Berlin", feature_flags: { board_swimlanes: true } },
      },
      {
        name: "Orbit Internal",
        slug: "orbit-internal",
        plan: "free",
        billingEmail: ada.email,
        maxProjects: 3,
        maxMembers: 5,
        settings: { timezone: "UTC" },
      },
    ])
    .returning();

  await db.insert(memberships).values([
    { tenantId: northwind.id, userId: ada.id, role: "owner", isDefault: true },
    { tenantId: northwind.id, userId: grace.id, role: "admin" },
    { tenantId: northwind.id, userId: linus.id, role: "member" },
    { tenantId: northwind.id, userId: margaret.id, role: "viewer" },
    { tenantId: internal.id, userId: ada.id, role: "owner", isDefault: true },
    { tenantId: internal.id, userId: grace.id, role: "viewer" },
  ]);

  const insertedProjects = await db
    .insert(projects)
    .values([
      {
        tenantId: northwind.id,
        name: "Website Relaunch",
        key: "WEB",
        description: "Rebuild the marketing site on a headless stack with a design system.",
        status: "active",
        color: "#6366f1",
        ownerId: ada.id,
        dueDate: days(30),
      },
      {
        tenantId: northwind.id,
        name: "Mobile App v2",
        key: "APP",
        description: "Offline-first rewrite of the iOS and Android clients.",
        status: "planning",
        color: "#22c55e",
        ownerId: grace.id,
        dueDate: days(90),
      },
      {
        tenantId: northwind.id,
        name: "Data Platform",
        key: "DATA",
        description: "Warehouse, ingestion and reporting layer for customer analytics.",
        status: "on_hold",
        color: "#f59e0b",
        ownerId: ada.id,
      },
      {
        tenantId: internal.id,
        name: "Internal Tooling",
        key: "OPS",
        description: "Everything the ops team needs to keep the lights on.",
        status: "active",
        color: "#0ea5e9",
        ownerId: ada.id,
      },
    ])
    .returning();
  const projectByKey = Object.fromEntries(insertedProjects.map((p) => [p.key, p]));

  const taskRows = [
    ["WEB", "Refresh marketing homepage", "done", "high", linus.id, 5, days(-6), 1],
    ["WEB", "Migrate CMS to headless backend", "in_progress", "urgent", grace.id, 8, days(12), 2],
    ["WEB", "Design system audit", "todo", "medium", margaret.id, 3, days(20), 3],
    ["WEB", "Set a performance budget for LCP", "backlog", "low", ada.id, 3, days(40), 4],
    ["APP", "Offline sync prototype", "in_progress", "urgent", linus.id, 13, days(9), 1],
    ["APP", "Push notification service", "todo", "high", ada.id, 5, days(25), 2],
    ["APP", "App store listing copy", "backlog", "low", null, 1, days(50), 3],
    ["DATA", "Warehouse schema v2", "blocked", "high", grace.id, 8, days(15), 1],
    ["DATA", "Retention policy backfill", "todo", "medium", linus.id, 5, days(18), 2],
    ["DATA", "Executive dashboard Q3", "done", "medium", margaret.id, 3, days(-2), 3],
    ["OPS", "Vendor contract tracker", "in_progress", "medium", ada.id, 3, days(11), 1],
    ["OPS", "Onboarding checklist automation", "todo", "low", grace.id, 2, days(21), 2],
  ];

  const insertedTasks = await db
    .insert(tasks)
    .values(
      taskRows.map(([key, title, status, priority, assigneeId, points, due, seq], index) => ({
        tenantId: projectByKey[key].tenantId,
        projectId: projectByKey[key].id,
        title,
        description: `Seeded task for the ${projectByKey[key].name} project.`,
        status,
        priority,
        assigneeId,
        reporterId: ada.id,
        sequence: seq,
        storyPoints: points,
        dueDate: due,
        completedAt: status === "done" ? hoursAgo(24 + index) : null,
      })),
    )
    .returning();

  const cmsTask = insertedTasks[1];
  const syncTask = insertedTasks[4];

  await db.insert(comments).values([
    {
      tenantId: northwind.id,
      taskId: cmsTask.id,
      authorId: ada.id,
      body: "Content freeze starts Friday - please land any copy changes before then.",
      createdAt: hoursAgo(30),
    },
    {
      tenantId: northwind.id,
      taskId: cmsTask.id,
      authorId: grace.id,
      body: "Migration dry run finished with 0 broken slugs. Ready for the real cutover.",
      createdAt: hoursAgo(6),
    },
    {
      tenantId: northwind.id,
      taskId: syncTask.id,
      authorId: linus.id,
      body: "Conflict resolution now prefers the newest server write. Writing tests next.",
      createdAt: hoursAgo(12),
    },
  ]);

  await db.insert(activityEvents).values([
    {
      tenantId: northwind.id,
      actorId: ada.id,
      verb: "created_project",
      objectType: "project",
      objectId: projectByKey.WEB.id,
      summary: "Ada Lovelace created the project Website Relaunch",
      createdAt: hoursAgo(96),
    },
    {
      tenantId: northwind.id,
      actorId: grace.id,
      verb: "updated_task",
      objectType: "task",
      objectId: cmsTask.id,
      summary: "Grace Hopper moved WEB-2 to in progress",
      createdAt: hoursAgo(48),
    },
    {
      tenantId: northwind.id,
      actorId: linus.id,
      verb: "commented",
      objectType: "task",
      objectId: syncTask.id,
      summary: "Linus Berg commented on Offline sync prototype",
      createdAt: hoursAgo(12),
    },
    {
      tenantId: internal.id,
      actorId: ada.id,
      verb: "created_project",
      objectType: "project",
      objectId: projectByKey.OPS.id,
      summary: "Ada Lovelace created the project Internal Tooling",
      createdAt: hoursAgo(80),
    },
  ]);

  const [{ value }] = await db.select({ value: sql`count(*)::int` }).from(tenants);
  return {
    created: true,
    tenants: value,
    email: ada.email,
    password: DEMO_PASSWORD,
    tenantSlug: northwind.slug,
  };
}
