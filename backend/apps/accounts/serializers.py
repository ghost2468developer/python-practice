from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from apps.tenancy.models import Membership, Tenant
from common.utils import unique_slug
from config.settings import TENANCY

from .models import User


class WorkspaceSerializer(serializers.ModelSerializer):
    role = serializers.CharField(read_only=True)

    class Meta:
        model = Tenant
        fields = ("id", "name", "slug", "plan", "max_projects", "max_members", "role", "joined_at")


class UserSerializer(serializers.ModelSerializer):
    workspaces = serializers.SerializerMethodField()
    initials = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ("id", "email", "full_name", "is_superuser", "date_joined", "initials", "workspaces")
        read_only_fields = ("id", "is_superuser", "date_joined")

    def get_workspaces(self, obj):
        return WorkspaceSerializer(
            [m for m in obj.memberships()], many=True
        ).data

    def get_initials(self, obj):
        parts = [part[0].upper() for part in (obj.full_name or obj.email).split()[:2]]
        return "".join(parts)


class RegisterSerializer(serializers.ModelSerializer):
    email = serializers.EmailField(max_length=254)
    password = serializers.CharField(write_only=True, trim_whitespace=False)
    workspace_name = serializers.CharField(required=False, allow_blank=True, max_length=120)

    class Meta:
        model = User
        fields = ("full_name", "email", "password", "workspace_name")

    def validate_email(self, value):
        email = value.lower()
        if User.objects.filter(email__iexact=email).exists():
            raise serializers.ValidationError("A user with that email address already exists.")
        return email

    def validate_password(self, value):
        validate_password(value)
        return value

    def create(self, validated_data):
        from apps.work.models import Project, Task

        workspace_name = validated_data.pop("workspace_name", "").strip()
        password = validated_data.pop("password")
        user = User.objects.create_user(password=password, **validated_data)

        workspace_name = workspace_name or f"{user.get_short_name()}'s Workspace"
        limits = TENANCY["PLANS"]["free"]
        tenant = Tenant.objects.create(
            name=workspace_name,
            slug=unique_slug(workspace_name, Tenant),
            plan="free",
            billing_email=user.email,
            max_projects=limits["max_projects"] or 1000,
            max_members=limits["max_members"] or 1000,
        )
        Membership.objects.create(tenant=tenant, user=user, role=Membership.Role.OWNER, is_default=True)

        project = Project.objects.create(
            tenant=tenant,
            name="Getting started",
            key="START",
            description="Your first project - rename it or archive it whenever you like.",
            status=Project.Status.ACTIVE,
            owner=user,
        )
        Task.objects.create(
            tenant=tenant,
            project=project,
            title="Invite your team",
            description="Owners and admins can invite teammates via POST /api/members/.",
            status=Task.Status.TODO,
            priority=Task.Priority.HIGH,
            reporter=user,
            assignee=user,
            story_points=2,
        )
        Task.objects.create(
            tenant=tenant,
            project=project,
            title="Create your first task",
            description="POST /api/tasks/ with a project id to add work to the backlog.",
            status=Task.Status.BACKLOG,
            priority=Task.Priority.MEDIUM,
            reporter=user,
            story_points=1,
        )
        self.context["tenant"] = tenant
        return user

    def to_representation(self, instance):
        membership = self.context.get("membership")
        return {
            "id": str(instance.id),
            "email": instance.email,
            "full_name": instance.full_name,
            "workspace": WorkspaceSerializer(membership).data if membership else None,
            "detail": "Account created - exchange your credentials for a token at /api/auth/token/.",
        }


class LoginSerializer(TokenObtainPairSerializer):
    """Embeds the active workspace and role into the token claims."""

    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        membership = user.memberships().first()
        token["full_name"] = user.full_name
        token["tenant_id"] = str(membership.tenant_id) if membership else None
        token["tenant_slug"] = membership.tenant.slug if membership else None
        token["role"] = membership.role if membership else None
        return token

    def validate(self, attrs):
        data = super().validate(attrs)
        membership = self.user.memberships().first()
        data["user"] = UserSerializer(self.user).data
        data["active_workspace"] = (
            {
                "id": str(membership.tenant_id),
                "name": membership.tenant.name,
                "slug": membership.tenant.slug,
                "role": membership.role,
            }
            if membership
            else None
        )
        return data


class ProfileUpdateSerializer(serializers.ModelSerializer):
    current_password = serializers.CharField(write_only=True, required=False, trim_whitespace=False)
    new_password = serializers.CharField(write_only=True, required=False, trim_whitespace=False)

    class Meta:
        model = User
        fields = ("full_name", "current_password", "new_password")

    def validate(self, attrs):
        new_password = attrs.get("new_password")
        if new_password:
            current = attrs.get("current_password")
            if not current or not self.instance.check_password(current):
                raise serializers.ValidationError({"current_password": "Current password is incorrect."})
            validate_password(new_password)
        if not attrs.get("full_name") and not new_password:
            raise serializers.ValidationError("Provide full_name or a password change.")
        return attrs

    def update(self, instance, validated_data):
        new_password = validated_data.pop("new_password", None)
        validated_data.pop("current_password", None)
        instance = super().update(instance, validated_data)
        if new_password:
            instance.set_password(new_password)
            instance.save(update_fields=["password"])
        return instance
