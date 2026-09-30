"""Projects, tasks, comments and the per-tenant audit trail."""
import uuid

from django.conf import settings as django_settings
from django.db import models
from django.utils import timezone

from common.models import Base

from apps.tenancy.models import Tenant


class Project(Base):
    class Status(models.TextChoices):
        PLANNING = "planning", "Planning"
        ACTIVE = "active", "Active"
        ON_HOLD = "on_hold", "On hold"
        COMPLETED = "completed", "Completed"
        ARCHIVED = "archived", "Archived"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="projects")
    name = models.CharField(max_length=120)
    key = models.CharField(max_length=10)
    description = models.TextField(blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PLANNING)
    color = models.CharField(max_length=9, default="#6366f1")
    owner = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="owned_projects"
    )
    due_date = models.DateTimeField(null=True, blank=True)
    is_archived = models.BooleanField(default=False)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=("tenant", "key"), name="unique_project_key_per_tenant")]
        indexes = [models.Index(fields=["tenant", "status"])]

    def __str__(self):
        return f"{self.key} · {self.name}"

    def save(self, *args, **kwargs):
        self.key = (self.key or "").upper()
        super().save(*args, **kwargs)


class Task(Base):
    class Status(models.TextChoices):
        BACKLOG = "backlog", "Backlog"
        TODO = "todo", "To do"
        IN_PROGRESS = "in_progress", "In progress"
        IN_REVIEW = "in_review", "In review"
        BLOCKED = "blocked", "Blocked"
        DONE = "done", "Done"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        URGENT = "urgent", "Urgent"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="tasks")
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    title = models.CharField(max_length=200)
    description = models.TextField(blank=True, default="")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.TODO)
    priority = models.CharField(max_length=16, choices=Priority.choices, default=Priority.MEDIUM)
    assignee = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="assigned_tasks"
    )
    reporter = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="reported_tasks"
    )
    sequence = models.PositiveIntegerField(default=1)
    story_points = models.PositiveIntegerField(default=0)
    due_date = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-updated_at"]
        constraints = [models.UniqueConstraint(fields=("project", "sequence"), name="unique_task_sequence_per_project")]
        indexes = [
            models.Index(fields=["tenant", "status"]),
            models.Index(fields=["project", "status"]),
            models.Index(fields=["assignee"]),
        ]

    def __str__(self):
        return f"{self.reference} · {self.title}"

    @property
    def reference(self):
        return f"{self.project.key}-{self.sequence}"

    def save(self, *args, **kwargs):
        if self.status == self.Status.DONE and self.completed_at is None:
            self.completed_at = timezone.now()
        elif self.status != self.Status.DONE:
            self.completed_at = None
        super().save(*args, **kwargs)


class Comment(Base):
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="comments")
    task = models.ForeignKey(Task, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="comments"
    )
    body = models.TextField()

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["task"])]

    def __str__(self):
        return f"Comment by {self.author} on {self.task_id}"


class ActivityEvent(Base):
    """Append-only audit log, one row per mutating action, always tenant scoped."""

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="activity")
    actor = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="activity"
    )
    verb = models.CharField(max_length=64)
    object_type = models.CharField(max_length=64)
    object_id = models.UUIDField(null=True, blank=True)
    summary = models.CharField(max_length=255)
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["tenant", "-created_at"])]

    def __str__(self):
        return f"{self.tenant.slug}: {self.summary}"

    @property
    def reference_id(self):
        return uuid.uuid4() if self.object_id is None else self.object_id
