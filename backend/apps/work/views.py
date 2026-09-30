from django.db.models import Count, Q, Sum
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.tenancy.models import Membership
from apps.tenancy.views import log
from common.permissions import IsTenantAdmin, IsTenantMember, ReadOnlyOrRoleRequired
from common.views import TenantScopedViewSet
from config.settings import TENANCY

from .filters import ActivityFilter, ProjectFilter, TaskFilter
from .models import ActivityEvent, Comment, Project, Task
from .serializers import (
    ActivitySerializer,
    CommentSerializer,
    CommentWriteSerializer,
    ProjectSerializer,
    ProjectWriteSerializer,
    TaskSerializer,
    TaskWriteSerializer,
    UserStubSerializer,
)

WRITE_ROLES = TENANCY["WRITE_ROLES"]


class ProjectViewSet(TenantScopedViewSet, viewsets.ModelViewSet):
    """
    /api/projects/     GET (filter, search, order, paginate) | POST
    /api/projects/{id}/  GET | PATCH | DELETE
    /api/projects/{id}/board/  GET - grouped by status
    """

    permission_classes = [ReadOnlyOrRoleRequired]
    tenant_roles = WRITE_ROLES
    filterset_class = ProjectFilter
    search_fields = ("name", "key", "description")
    ordering_fields = ("name", "created_at", "due_date")
    ordering = ("-created_at",)

    def get_queryset(self):
        return (
            Project.objects.filter(tenant=self.get_tenant())
            .select_related("owner")
            .annotate(
                total_task_count=Count("tasks", distinct=True),
                open_task_count=Count("tasks", filter=~Q(tasks__status=Task.Status.DONE), distinct=True),
            )
        )

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return ProjectWriteSerializer
        return ProjectSerializer

    def get_permissions(self):
        if self.action == "destroy":
            return [permission() for permission in [IsTenantAdmin]]
        return super().get_permissions()

    def perform_create(self, serializer):
        project = serializer.save()
        log(
            self.request,
            "created_project",
            "project",
            project.id,
            f"{self.request.user.full_name} created the project {project.name}",
            {"key": project.key},
        )

    def perform_update(self, serializer):
        project = serializer.save()
        log(
            self.request,
            "updated_project",
            "project",
            project.id,
            f"{self.request.user.full_name} updated project {project.name}",
        )

    def perform_destroy(self, instance):
        name = instance.name
        log(self.request, "deleted_project", "project", None, f"{self.request.user.full_name} deleted project {name}")
        instance.delete()

    @action(detail=True, methods=["get"], permission_classes=[IsTenantMember])
    def board(self, request, pk=None):
        project = self.get_object()
        rows = (
            Task.objects.filter(project=project)
            .values("status")
            .annotate(total=Count("id"), points=Count("story_points"))
        )
        return Response(
            {
                "project": ProjectSerializer(project, context=self.get_serializer_context()).data,
                "columns": {row["status"]: row["total"] for row in rows},
            }
        )


class TaskViewSet(TenantScopedViewSet, viewsets.ModelViewSet):
    """
    /api/tasks/          GET | POST
    /api/tasks/{id}/     GET | PATCH | DELETE
    /api/tasks/{id}/comments/  GET | POST
    """

    permission_classes = [ReadOnlyOrRoleRequired]
    tenant_roles = WRITE_ROLES
    filterset_class = TaskFilter
    search_fields = ("title", "description")
    ordering_fields = ("created_at", "updated_at", "due_date", "priority")
    ordering = ("-created_at",)

    def get_queryset(self):
        return (
            Task.objects.filter(tenant=self.get_tenant())
            .select_related("project", "assignee", "reporter")
            .prefetch_related("comments")
            .annotate(comment_count=Count("comments", distinct=True))
        )

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return TaskWriteSerializer
        return TaskSerializer

    def get_permissions(self):
        if self.action in ("create", "update", "partial_update", "destroy"):
            return [permission() for permission in [ReadOnlyOrRoleRequired]]
        return super().get_permissions()

    def perform_create(self, serializer):
        task = serializer.save()
        log(
            self.request,
            "created_task",
            "task",
            task.id,
            f"{self.request.user.full_name} created {task.reference} · {task.title}",
            {"project": task.project.name, "status": task.status},
        )

    def perform_update(self, serializer):
        task = serializer.save()
        log(
            self.request,
            "updated_task",
            "task",
            task.id,
            f"{self.request.user.full_name} updated {task.reference} ({task.status})",
        )

    def perform_destroy(self, instance):
        title = instance.title
        log(self.request, "deleted_task", "task", None, f"{self.request.user.full_name} deleted task \"{title}\"")
        instance.delete()

    @action(detail=True, methods=["get", "post"], permission_classes=[IsTenantMember], url_path="comments")
    def comments(self, request, pk=None):
        task = self.get_object()
        if request.method == "POST":
            serializer = CommentWriteSerializer(data=request.data, context={"request": request, "task": task})
            serializer.is_valid(raise_exception=True)
            comment = serializer.save()
            log(request, "commented", "task", task.id, f"{request.user.full_name} commented on {task.title}")
            return Response(
                CommentSerializer(comment, context=self.get_serializer_context()).data,
                status=status.HTTP_201_CREATED,
            )

        comments = task.comments.select_related("author").all()
        page = self.paginate_queryset(comments)
        serializer = CommentSerializer(page if page is not None else comments, many=True, context=self.get_serializer_context())
        return (
            self.get_paginated_response(serializer.data)
            if page is not None
            else Response({"count": comments.count(), "results": serializer.data})
        )


class ActivityViewSet(TenantScopedViewSet, mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    """Read-only audit trail for the active workspace."""

    serializer_class = ActivitySerializer
    permission_classes = [IsTenantMember]
    filterset_class = ActivityFilter
    ordering_fields = ("created_at",)
    ordering = ("-created_at",)

    def get_queryset(self):
        return ActivityEvent.objects.filter(tenant=self.get_tenant()).select_related("actor")


class SummaryViewSet(TenantScopedViewSet, mixins.ListModelMixin, viewsets.GenericViewSet):
    """GET /api/summary/ - dashboard aggregates for the active workspace."""

    permission_classes = [IsTenantMember]
    serializer_class = ActivitySerializer
    pagination_class = None

    def list(self, request, *args, **kwargs):
        tenant = self.get_tenant()
        tasks = Task.objects.filter(tenant=tenant)

        total = tasks.count()
        done = tasks.filter(status=Task.Status.DONE).count()
        mine = tasks.filter(assignee_id=request.user.id).exclude(status=Task.Status.DONE).count()

        by_status = {row["status"]: row["total"] for row in tasks.values("status").annotate(total=Count("id"))}
        by_priority = {row["priority"]: row["total"] for row in tasks.values("priority").annotate(total=Count("id"))}

        projects = (
            Project.objects.filter(tenant=tenant)
            .annotate(
                total=Count("tasks", distinct=True),
                done=Count("tasks", filter=Q(tasks__status=Task.Status.DONE), distinct=True),
            )
            .order_by("name")
        )

        workload = [
            {"assignee": row["assignee__full_name"], "total": row["total"]}
            for row in tasks.filter(assignee__isnull=False)
            .values("assignee__full_name")
            .annotate(total=Count("id"))
            .order_by("-total")[:6]
        ]

        recent = ActivityEvent.objects.filter(tenant=tenant).select_related("actor")[:6]

        return Response(
            {
                "workspace": {"id": str(tenant.id), "name": tenant.name, "slug": tenant.slug, "plan": tenant.plan},
                "me": UserStubSerializer(request.user).data | {"role": request.role},
                "totals": {
                    "projects": tenant.projects.count(),
                    "active_projects": tenant.projects.filter(status=Project.Status.ACTIVE).count(),
                    "members": tenant.memberships.count(),
                    "tasks": total,
                    "open_tasks": total - done,
                    "completed_tasks": done,
                    "my_open_tasks": mine,
                    "completion_rate": round((done / total) * 100) if total else 0,
                },
                "by_status": by_status,
                "by_priority": by_priority,
                "projects": [
                    {
                        "id": str(project.id),
                        "name": project.name,
                        "key": project.key,
                        "total": project.total,
                        "done": project.done,
                        "progress": round((project.done / project.total) * 100) if project.total else 0,
                    }
                    for project in projects
                ],
                "workload": workload,
                "recent_activity": ActivitySerializer(recent, many=True, context=self.get_serializer_context()).data,
            }
        )


class HealthView(IsTenantMember):  # pragma: no cover - documentation helper only
    """Keeps import paths tidy for third party integrations."""
