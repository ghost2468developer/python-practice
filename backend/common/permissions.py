"""
Object level permissions for a multi-tenant SaaS.

A request is authorised when:
  1. the user is authenticated, and
  2. the user has an active membership for the tenant resolved from the JWT
     claims (or the ``X-Tenant-Slug`` header), and
  3. the role on that membership satisfies the view's ``tenant_roles``.
"""
from rest_framework.permissions import SAFE_METHODS, BasePermission

ROLE_RANK = {"viewer": 1, "member": 2, "admin": 3, "owner": 4}


class IsTenantMember(BasePermission):
    """Any role, including read-only viewers."""

    message = "You are not a member of this workspace."

    def has_permission(self, request, view):
        return getattr(request, "membership", None) is not None


class RoleRequired(BasePermission):
    """
    Use with ``tenant_roles`` on the view::

        class ProjectViewSet(TenantScopedViewSet):
            tenant_roles = ("owner", "admin", "member")
    """

    message = "Your role does not allow this action."

    def has_permission(self, request, view):
        membership = getattr(request, "membership", None)
        if membership is None:
            return False
        required = getattr(view, "tenant_roles", None) or ("owner", "admin", "member", "viewer")
        return membership.role in required


class IsTenantAdmin(RoleRequired):
    message = "Only workspace owners and admins may perform this action."

    def has_permission(self, request, view):
        view.tenant_roles = ("owner", "admin")
        return super().has_permission(request, view)


class IsTenantOwner(RoleRequired):
    message = "Only the workspace owner may perform this action."

    def has_permission(self, request, view):
        view.tenant_roles = ("owner",)
        return super().has_permission(request, view)


class ReadOnlyOrRoleRequired(RoleRequired):
    """Viewers may read; every unsafe method needs the view's ``tenant_roles``."""

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return IsTenantMember().has_permission(request, view)
        return super().has_permission(request, view)
