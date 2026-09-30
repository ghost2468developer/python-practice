from rest_framework.routers import DefaultRouter

from .views import InvitationViewSet, MembershipViewSet, TenantViewSet

router = DefaultRouter()
router.register("tenants", TenantViewSet, basename="tenant")
router.register("members", MembershipViewSet, basename="member")
router.register("invitations", InvitationViewSet, basename="invitation")

urlpatterns = router.urls
