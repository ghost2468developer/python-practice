"""
Resolves the *active tenant* for every DRF request and attaches it to the
request object so permissions, serializers and querysets can rely on it.

Resolution order:
  1. ``X-Tenant-Slug`` header  -> the caller explicitly picked a workspace
  2. ``tenant_id`` JWT claim   -> the workspace chosen at login time

The membership row is re-verified on every request, so a revoked invite stops
working immediately even if the token is still valid.
"""
from rest_framework.exceptions import PermissionDenied

from apps.tenancy.models import Membership
from config.settings import TENANCY


class TenantResolutionError(PermissionDenied):
    default_detail = "You are not a member of this workspace."
    default_code = "not_a_tenant_member"


def resolve_membership(request):
    user = getattr(request, "user", None)
    if user is None or not user.is_authenticated:
        return None

    slug = request.META.get(TENANCY["TENANT_HEADER"], "").strip()
    lookup = {"tenant__slug": slug} if slug else {"tenant_id": request.auth.get("tenant_id", "") if request.auth else ""}

    membership = (
        Membership.objects.filter(user=user, **lookup)
        .select_related("tenant", "user")
        .order_by("created_at")
        .first()
    )
    if membership is None:
        # A user with no workspace at all may still create one.
        if not Membership.objects.filter(user=user).exists():
            return None
        if slug:
            raise TenantResolutionError(f'You are not a member of the workspace "{slug}".')
        raise TenantResolutionError("No workspace is associated with this account.")
    return membership


class AuditContextMiddleware:
    """Records request timing and exposes it on the response for debugging."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        import time

        started = time.perf_counter()
        response = self.get_response(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        response["X-Process-Time-Ms"] = f"{elapsed_ms:.1f}"
        return response
