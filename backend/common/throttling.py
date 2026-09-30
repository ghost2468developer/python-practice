"""Rate limiting that is fair for a multi-tenant workload."""
from rest_framework.throttling import SimpleRateThrottle


class TenantScopedThrottle(SimpleRateThrottle):
    """One bucket per workspace so a busy tenant cannot starve the others."""

    scope = "tenant"

    def get_cache_key(self, request, view):
        tenant = getattr(request, "tenant", None)
        if tenant is not None:
            return self.cache_format % {"scope": self.scope, "ident": f"tenant:{tenant.id}"}
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            return self.cache_format % {"scope": self.scope, "ident": f"user:{user.id}"}
        return None


class AuthThrottle(SimpleRateThrottle):
    """IP based throttle for the unauthenticated endpoints."""

    scope = "auth"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}
