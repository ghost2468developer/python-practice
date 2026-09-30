from django.contrib.auth import get_user_model
from rest_framework import mixins, status, viewsets
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.work.models import ActivityEvent
from common.permissions import IsTenantAdmin, IsTenantMember, IsTenantOwner
from common.views import TenantScopedViewSet

from .models import Invitation, Membership, Tenant
from .serializers import (
    AddMemberSerializer,
    InvitationSerializer,
    MembershipSerializer,
    TenantCreateSerializer,
    TenantSerializer,
    TenantUpdateSerializer,
)

User = get_user_model()


def log(request, verb, object_type, object_id=None, summary="", metadata=None):
    ActivityEvent.objects.create(
        tenant=request.tenant,
        actor=request.user,
        verb=verb,
        object_type=object_type,
        object_id=object_id,
        summary=summary or f"{request.user.full_name} {verb.replace('_', ' ')}",
        metadata=metadata or {},
    )


class TenantViewSet(TenantScopedViewSet, viewsets.ModelViewSet):
    """
    /api/tenants/          GET   every workspace the caller belongs to
                           POST  create a new workspace (caller becomes owner)
    /api/tenants/{id}/     GET | PATCH | DELETE
    """

    permission_classes = [IsAuthenticated]
    search_fields = ("name", "slug")
    ordering_fields = ("name", "created_at")
    filterset_fields = ("plan",)

    def get_queryset(self):
        return (
            Tenant.objects.filter(memberships__user=self.request.user)
            .distinct()
            .prefetch_related("memberships", "projects")
        )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context["memberships"] = {m.tenant_id: m for m in Membership.objects.filter(user=self.request.user)}
        return context

    def get_serializer_class(self):
        if self.action == "create":
            return TenantCreateSerializer
        if self.action in ("update", "partial_update"):
            return TenantUpdateSerializer
        return TenantSerializer

    def get_permissions(self):
        if self.action in ("update", "partial_update"):
            return [permission() for permission in [IsTenantAdmin]]
        if self.action == "destroy":
            return [permission() for permission in [IsTenantOwner]]
        return super().get_permissions()

    def perform_create(self, serializer):
        tenant = serializer.save()
        log(self.request, "created_workspace", "tenant", tenant.id, f"{self.request.user.full_name} created {tenant.name}")

    def perform_destroy(self, instance):
        owners = instance.memberships.filter(role=Membership.Role.OWNER).count()
        if owners <= 1:
            raise ValidationError("A workspace must always keep at least one owner.")
        log(self.request, "deleted_workspace", "tenant", instance.id, f"{self.request.user.full_name} deleted {instance.name}")
        instance.delete()


class MembershipViewSet(TenantScopedViewSet, viewsets.ModelViewSet):
    """Seat management for the *active* workspace."""

    serializer_class = MembershipSerializer
    permission_classes = [IsTenantMember]

    def get_queryset(self):
        return (
            Membership.objects.filter(tenant=self.get_tenant())
            .select_related("user", "tenant")
            .order_by("created_at")
        )

    def get_serializer_class(self):
        if self.action == "create":
            return AddMemberSerializer
        return MembershipSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permission() for permission in [IsTenantAdmin]]
        return super().get_permissions()

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = serializer.save()

        if isinstance(result, Invitation):
            payload = InvitationSerializer(result, context=self.get_serializer_context()).data
            payload["detail"] = "Invitation created — ask the teammate to register with this email."
            log(request, "invited_member", "invitation", result.id, f"{request.user.full_name} invited {result.email}")
            return Response(payload, status=status.HTTP_201_CREATED)

        payload = MembershipSerializer(result, context=self.get_serializer_context()).data
        log(request, "added_member", "membership", result.id, f"{request.user.full_name} added {result.user.email}")
        return Response(payload, status=status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        previous = serializer.instance.role
        membership = serializer.save()
        if previous != membership.role:
            log(
                self.request,
                "changed_role",
                "membership",
                membership.id,
                f"{self.request.user.full_name} set {membership.user.email} to {membership.role}",
                {"from": previous, "to": membership.role},
            )

    def perform_destroy(self, instance):
        if instance.role == Membership.Role.OWNER and self.request.role != Membership.Role.OWNER:
            raise ValidationError("Admins cannot remove an owner.")
        if instance.user_id == self.request.user.id:
            raise ValidationError("Ask another owner to remove you, or delete the workspace instead.")
        email = instance.user.email
        log(self.request, "removed_member", "membership", instance.id, f"{self.request.user.full_name} removed {email}")
        instance.delete()


class InvitationViewSet(
    TenantScopedViewSet,
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    """Pending seats for the active workspace."""

    serializer_class = InvitationSerializer
    permission_classes = [IsTenantMember]

    def get_queryset(self):
        return Invitation.objects.filter(tenant=self.get_tenant()).select_related("tenant")

    def get_serializer_class(self):
        return InviteSerializer if self.action == "create" else InvitationSerializer

    def get_permissions(self):
        if self.action in ("create", "destroy"):
            return [permission() for permission in [IsTenantAdmin]]
        return super().get_permissions()

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        invitation = serializer.save()
        payload = InvitationSerializer(invitation, context=self.get_serializer_context()).data
        payload["detail"] = "Invitation created — ask the teammate to register with this email."
        return Response(payload, status=status.HTTP_201_CREATED)

    def perform_create(self, serializer):
        invitation = serializer.instance
        log(
            self.request,
            "invited_member",
            "invitation",
            invitation.id,
            f"{self.request.user.full_name} invited {invitation.email} as {invitation.role}",
        )

    def perform_destroy(self, instance):
        instance.status = Invitation.Status.REVOKED
        instance.save(update_fields=["status", "updated_at"])
