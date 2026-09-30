from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.work.models import Task
from common.utils import unique_slug
from config.settings import TENANCY

from .models import Invitation, Membership, Tenant

User = get_user_model()


class TenantSerializer(serializers.ModelSerializer):
    role = serializers.SerializerMethodField()
    usage = serializers.SerializerMethodField()

    class Meta:
        model = Tenant
        fields = (
            "id",
            "name",
            "slug",
            "plan",
            "billing_email",
            "max_projects",
            "max_members",
            "settings",
            "created_at",
            "role",
            "usage",
        )
        read_only_fields = fields

    def get_role(self, obj):
        membership = self.context.get("memberships", {}).get(obj.id)
        return membership.role if membership else None

    def get_usage(self, obj):
        return {
            "projects": obj.projects.count(),
            "members": obj.members_count,
            "open_tasks": Task.objects.filter(tenant=obj).exclude(status=Task.Status.DONE).count(),
        }


class TenantCreateSerializer(serializers.ModelSerializer):
    plan = serializers.ChoiceField(choices=Tenant.Plan.choices, required=False, default=Tenant.Plan.FREE)

    class Meta:
        model = Tenant
        fields = ("name", "plan", "billing_email")

    def create(self, validated_data):
        request = self.context["request"]
        plan = validated_data.get("plan", Tenant.Plan.FREE)
        limits = TENANCY["PLANS"][plan]
        tenant = Tenant.objects.create(
            name=validated_data["name"],
            slug=unique_slug(validated_data["name"], Tenant),
            plan=plan,
            billing_email=validated_data.get("billing_email") or request.user.email,
            max_projects=limits.get("max_projects") or 1000,
            max_members=limits.get("max_members") or 1000,
        )
        Membership.objects.create(tenant=tenant, user=request.user, role=Membership.Role.OWNER)
        return tenant


class TenantUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Tenant
        fields = ("name", "billing_email", "plan", "settings")

    def validate_plan(self, value):
        request = self.context["request"]
        if value != self.instance.plan and request.role != Membership.Role.OWNER:
            raise serializers.ValidationError("Only workspace owners can change the subscription plan.")
        return value

    def save(self, **kwargs):
        instance = super().save(**kwargs)
        if "plan" in self.validated_data:
            instance.apply_plan_limits()
            instance.save(update_fields=["max_projects", "max_members"])
        return instance


class MembershipUserSerializer(serializers.Serializer):
    id = serializers.CharField(source="user.id")
    email = serializers.EmailField(source="user.email")
    full_name = serializers.CharField(source="user.full_name")
    initials = serializers.SerializerMethodField()

    def get_initials(self, obj):
        parts = [part[0].upper() for part in (obj.user.full_name or obj.user.email).split()[:2]]
        return "".join(parts)


class MembershipSerializer(serializers.ModelSerializer):
    user = MembershipUserSerializer(source="*")
    tenant = serializers.SerializerMethodField()

    class Meta:
        model = Membership
        fields = ("id", "role", "is_default", "created_at", "user", "tenant")

    def get_tenant(self, obj):
        return {"id": str(obj.tenant_id), "name": obj.tenant.name, "slug": obj.tenant.slug}


class AddMemberSerializer(serializers.Serializer):
    """Adds an existing user, or reserves a seat with an invitation."""

    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=Membership.Role.choices, default=Membership.Role.MEMBER)
    full_name = serializers.CharField(required=False, allow_blank=True, max_length=120)

    def validate_role(self, value):
        request = self.context["request"]
        if value == Membership.Role.OWNER and request.role != Membership.Role.OWNER:
            raise serializers.ValidationError("Only workspace owners can grant the owner role.")
        return value

    def validate(self, attrs):
        tenant = self.context["request"].tenant
        if tenant.max_members and tenant.memberships.count() >= tenant.max_members:
            raise serializers.ValidationError(
                {
                    "detail": (
                        f'Plan "{tenant.plan}" allows {tenant.max_members} members. '
                        "Upgrade the workspace to add more seats."
                    )
                }
            )
        return attrs

    def create(self, validated_data):
        request = self.context["request"]
        tenant = request.tenant
        email = validated_data["email"].lower()

        user = User.objects.filter(email__iexact=email).first()
        if user:
            membership, created = Membership.objects.get_or_create(
                tenant=tenant, user=user, defaults={"role": validated_data["role"]}
            )
            if not created:
                raise serializers.ValidationError({"email": "This user is already a member of the workspace."})
            return membership

        invitation, created = Invitation.objects.get_or_create(
            tenant=tenant,
            email=email,
            defaults={
                "role": validated_data["role"],
                "invited_by": request.user,
            },
        )
        if not created:
            raise serializers.ValidationError({"email": "An invitation for this email is already pending."})
        return invitation


class InvitationSerializer(serializers.ModelSerializer):
    tenant = serializers.SerializerMethodField()
    is_expired = serializers.BooleanField(read_only=True)

    class Meta:
        model = Invitation
        fields = ("id", "email", "role", "token", "status", "expires_at", "is_expired", "tenant", "created_at")


class InviteSerializer(serializers.Serializer):
    """Creates a pending invitation for someone who has no account yet."""

    email = serializers.EmailField()
    role = serializers.ChoiceField(choices=Membership.Role.choices, default=Membership.Role.MEMBER)

    def validate_email(self, value):
        email = value.lower()
        if Invitation.objects.filter(tenant=self.context["request"].tenant, email__iexact=email).exists():
            raise serializers.ValidationError("An invitation for this email is already pending.")
        return email

    def create(self, validated_data):
        request = self.context["request"]
        return Invitation.objects.create(
            tenant=request.tenant,
            email=validated_data["email"],
            role=validated_data["role"],
            invited_by=request.user,
        )

    def get_tenant(self, obj):
        return {"id": str(obj.tenant_id), "slug": obj.tenant.slug, "name": obj.tenant.name}
