from django.contrib.auth import get_user_model
from rest_framework import serializers

from apps.tenancy.models import Membership
from common.utils import project_key_from_name

from .models import ActivityEvent, Comment, Project, Task

User = get_user_model()

READ_ONLY_ROLE = Membership.Role.VIEWER


class UserStubSerializer(serializers.Serializer):
    id = serializers.CharField()
    email = serializers.EmailField()
    full_name = serializers.CharField()
    initials = serializers.SerializerMethodField()

    def get_initials(self, obj):
        parts = [part[0].upper() for part in (obj.full_name or obj.email).split()[:2]]
        return "".join(parts)


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------
class ProjectSerializer(serializers.ModelSerializer):
    owner = UserStubSerializer(read_only=True)
    tenant = serializers.CharField(source="tenant_id", read_only=True)
    total_task_count = serializers.SerializerMethodField()
    open_task_count = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = (
            "id",
            "name",
            "key",
            "description",
            "status",
            "color",
            "is_archived",
            "due_date",
            "created_at",
            "updated_at",
            "tenant",
            "owner",
            "total_task_count",
            "open_task_count",
        )
        read_only_fields = ("id", "created_at", "updated_at", "tenant")

    def get_total_task_count(self, obj):
        return getattr(obj, "total_task_count", None) or obj.tasks.count()

    def get_open_task_count(self, obj):
        if hasattr(obj, "open_task_count"):
            return obj.open_task_count
        return obj.tasks.exclude(status=Task.Status.DONE).count()


class ProjectWriteSerializer(serializers.ModelSerializer):
    owner_id = serializers.UUIDField(required=False, allow_null=True)

    class Meta:
        model = Project
        fields = ("name", "key", "description", "status", "color", "due_date", "owner_id", "is_archived")

    def validate_name(self, value):
        if not value.strip():
            raise serializers.ValidationError("This field may not be blank.")
        return value.strip()

    def validate_key(self, value):
        return (value or "").upper()

    def validate(self, attrs):
        tenant = self.context["request"].tenant
        # Plan quota — enforced on create only.
        if self.instance is None:
            max_projects = tenant.max_projects
            if max_projects and tenant.projects.count() >= max_projects:
                raise serializers.ValidationError(
                    {
                        "detail": (
                            f'Plan "{tenant.plan}" allows {max_projects} projects. '
                            "Upgrade the workspace to add more."
                        )
                    }
                )
            candidate = attrs.get("key") or project_key_from_name(attrs.get("name", ""))
            if Project.objects.filter(tenant=tenant, key=candidate).exists():
                raise serializers.ValidationError({"key": "Project keys must be unique inside a workspace."})
        else:
            candidate = attrs.get("key", self.instance.key)
            if (
                candidate
                and Project.objects.filter(tenant=tenant, key=candidate).exclude(pk=self.instance.pk).exists()
            ):
                raise serializers.ValidationError({"key": "Project keys must be unique inside a workspace."})

        owner_id = attrs.get("owner_id")
        if owner_id and not Membership.objects.filter(tenant=tenant, user_id=owner_id).exists():
            raise serializers.ValidationError({"owner_id": "User is not a member of this workspace."})
        return attrs

    def create(self, validated_data):
        validated_data["key"] = validated_data.get("key") or project_key_from_name(validated_data["name"])
        validated_data.setdefault("owner_id", self.context["request"].user.id)
        return Project.objects.create(tenant=self.context["request"].tenant, **validated_data)


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------
class TaskProjectSerializer(serializers.Serializer):
    id = serializers.CharField()
    name = serializers.CharField()
    key = serializers.CharField()


class TaskSerializer(serializers.ModelSerializer):
    reference = serializers.CharField(read_only=True)
    project = TaskProjectSerializer(read_only=True)
    assignee = UserStubSerializer(read_only=True)
    reporter = UserStubSerializer(read_only=True)
    comment_count = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = (
            "id",
            "reference",
            "title",
            "description",
            "status",
            "priority",
            "story_points",
            "due_date",
            "completed_at",
            "created_at",
            "updated_at",
            "project",
            "assignee",
            "reporter",
            "comment_count",
        )
        read_only_fields = fields

    def get_comment_count(self, obj):
        return getattr(obj, "comment_count", None) or obj.comments.count()


class TaskWriteSerializer(serializers.ModelSerializer):
    project_id = serializers.UUIDField(required=False)
    assignee_id = serializers.UUIDField(required=False, allow_null=True)

    class Meta:
        model = Task
        fields = (
            "title",
            "description",
            "status",
            "priority",
            "story_points",
            "due_date",
            "project_id",
            "assignee_id",
        )

    def validate_title(self, value):
        if not value.strip():
            raise serializers.ValidationError("This field may not be blank.")
        return value.strip()

    def validate(self, attrs):
        tenant = self.context["request"].tenant
        project_id = attrs.get("project_id", getattr(self.instance, "project_id", None))
        if not project_id:
            raise serializers.ValidationError({"project_id": "This field is required."})
        project = Project.objects.filter(tenant=tenant, id=project_id).first()
        if project is None:
            raise serializers.ValidationError({"project_id": "Project does not exist in this workspace."})

        assignee_id = attrs.get("assignee_id", getattr(self.instance, "assignee_id", None))
        if assignee_id and not Membership.objects.filter(tenant=tenant, user_id=assignee_id).exists():
            raise serializers.ValidationError({"assignee_id": "Assignee must be a member of this workspace."})

        self.context["project"] = project
        return attrs

    def create(self, validated_data):
        project = self.context["project"]
        last = Task.objects.filter(project=project).order_by("-sequence").first()
        validated_data.pop("project_id", None)
        return Task.objects.create(
            tenant=self.context["request"].tenant,
            project=project,
            sequence=(last.sequence + 1) if last else 1,
            reporter=self.context["request"].user,
            **validated_data,
        )


# ---------------------------------------------------------------------------
# Comments & activity
# ---------------------------------------------------------------------------
class CommentSerializer(serializers.ModelSerializer):
    author = UserStubSerializer(read_only=True)
    task = serializers.CharField(source="task_id", read_only=True)

    class Meta:
        model = Comment
        fields = ("id", "body", "author", "task", "created_at", "updated_at")
        read_only_fields = ("id", "created_at", "updated_at", "task")


class CommentWriteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Comment
        fields = ("body",)

    def validate_body(self, value):
        if not value.strip():
            raise serializers.ValidationError("This field may not be blank.")
        return value.strip()

    def create(self, validated_data):
        return Comment.objects.create(
            tenant=self.context["request"].tenant,
            task=self.context["task"],
            author=self.context["request"].user,
            **validated_data,
        )


class ActivitySerializer(serializers.ModelSerializer):
    actor = UserStubSerializer(read_only=True)

    class Meta:
        model = ActivityEvent
        fields = ("id", "verb", "object_type", "object_id", "summary", "metadata", "actor", "created_at")
