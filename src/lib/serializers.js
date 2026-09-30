/**
 * Output shapes mirror the DRF serializers in the Django backend so responses
 * are byte-for-byte compatible across both implementations.
 */

export const userStub = (user) =>
  user
    ? {
        id: user.id,
        email: user.email,
        full_name: user.fullName,
        initials: initialsOf(user.fullName ?? user.email ?? "?"),
      }
    : null;

function initialsOf(name) {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export const serializeTenant = (tenant, extra = {}) => ({
  id: tenant.id,
  name: tenant.name,
  slug: tenant.slug,
  plan: tenant.plan,
  billing_email: tenant.billingEmail ?? null,
  max_projects: tenant.maxProjects,
  max_members: tenant.maxMembers,
  settings: tenant.settings ?? {},
  created_at: tenant.createdAt,
  ...extra,
});

export const serializeUser = (user) => ({
  id: user.id,
  email: user.email,
  full_name: user.fullName,
  is_superuser: user.isSuperuser,
  date_joined: user.createdAt,
  workspaces: user.workspaces ?? undefined,
});

export const serializeMembership = (row) => ({
  id: row.membershipId ?? row.id,
  role: row.role,
  is_default: row.isDefault,
  joined_at: row.joinedAt ?? row.createdAt,
  user: userStub({
    id: row.userId ?? row.user?.id,
    email: row.userEmail ?? row.user?.email,
    fullName: row.userFullName ?? row.user?.fullName,
  }),
  tenant: row.tenantId
    ? {
        id: row.tenantId ?? row.tenant?.id,
        name: row.tenantName ?? row.tenant?.name,
        slug: row.tenantSlug ?? row.tenant?.slug,
      }
    : undefined,
});

export const serializeProject = (project) => ({
  id: project.id,
  name: project.name,
  key: project.key,
  description: project.description,
  status: project.status,
  color: project.color,
  is_archived: project.isArchived,
  due_date: project.dueDate,
  created_at: project.createdAt,
  updated_at: project.updatedAt,
  tenant: project.tenantId,
  owner: userStub(project.owner),
  open_task_count: project.openTaskCount ?? undefined,
  total_task_count: project.totalTaskCount ?? undefined,
});

export const serializeTask = (task) => ({
  id: task.id,
  reference: `${task.projectKey ?? projectKeyFallback(task)}-${task.sequence ?? task.number ?? ""}`,
  title: task.title,
  description: task.description,
  status: task.status,
  priority: task.priority,
  story_points: task.storyPoints,
  due_date: task.dueDate,
  completed_at: task.completedAt,
  created_at: task.createdAt,
  updated_at: task.updatedAt,
  project: {
    id: task.projectId,
    name: task.projectName,
    key: task.projectKey,
  },
  assignee: userStub(task.assignee),
  reporter: userStub(task.reporter),
  comment_count: task.commentCount ?? undefined,
});

function projectKeyFallback(task) {
  return task.projectKey ?? String(task.projectId ?? "").slice(0, 4).toUpperCase();
}

export const serializeComment = (comment) => ({
  id: comment.id,
  body: comment.body,
  created_at: comment.createdAt,
  updated_at: comment.updatedAt,
  task: comment.taskId,
  author: userStub(comment.author),
});

export const serializeActivity = (event) => ({
  id: event.id,
  verb: event.verb,
  object_type: event.objectType,
  object_id: event.objectId,
  summary: event.summary,
  metadata: event.metadata ?? {},
  created_at: event.createdAt,
  actor: userStub(event.actor),
});
