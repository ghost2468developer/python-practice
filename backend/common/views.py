"""
Base viewset that every tenant-scoped endpoint inherits from.

``perform_authentication`` runs *before* ``check_permissions`` in DRF's
``initial()``, which is exactly where the tenant must be resolved: permissions
need it to answer "is this role allowed?".
"""
from rest_framework import viewsets

from common.middleware import resolve_membership


class TenantScopedViewSet(viewsets.GenericViewSet):
    """
    Adds to the request:
      * ``request.membership`` – the Membership row for the active workspace
      * ``request.tenant``     – the Tenant row
      * ``request.role``       – convenience accessor for the role slug
    """

    def perform_authentication(self, request):
        super().perform_authentication(request)
        request.membership = resolve_membership(request)
        request.tenant = request.membership.tenant if request.membership else None
        request.role = request.membership.role if request.membership else None

    @property
    def allowed_roles(self):
        return getattr(self, "tenant_roles", ("owner", "admin", "member", "viewer"))

    def get_tenant(self):
        if getattr(self.request, "tenant", None) is None:
            self.perform_authentication(self.request)
        return self.request.tenant
