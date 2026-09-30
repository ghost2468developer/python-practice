import { ApiError } from "./http";
import { authenticate, resolveTenant } from "./tenancy";

export function toTenantShape(row) {
  return {
    id: row.tenantId ?? row.id,
    name: row.tenantName ?? row.name,
    slug: row.tenantSlug ?? row.slug,
    plan: row.tenantPlan ?? row.plan,
    billing_email: row.billingEmail ?? row.billingEmail ?? null,
    max_projects: row.maxProjects,
    max_members: row.maxMembers,
    settings: row.settings ?? {},
    created_at: row.createdAt,
  };
}

/**
 * Combined authentication + tenant scoping + role authorisation.
 * Equivalent to Django's `IsAuthenticated & TenantMemberRequired` permission
 * chain resolved in a single middleware step.
 */
export async function guard(request, options = {}) {
  const { user, claims } = await authenticate(request);
  const { tenant, membership } = await resolveTenant(user, claims, request);
  if (options.roles) requireRoleFor(membership, options.roles);
  return {
    user,
    claims,
    membership,
    role: membership.role,
    tenant: toTenantShape(tenant),
    tenantId: tenant.tenantId,
  };
}

function requireRoleFor(membership, allowed) {
  if (!allowed.includes(membership.role)) {
    throw new ApiError(403, {
      detail: `Requires one of the following roles: ${allowed.join(", ")}. Your role is "${membership.role}".`,
      code: "permission_denied",
    });
  }
}
