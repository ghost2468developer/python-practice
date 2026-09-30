from django.contrib import admin

from .models import ActivityEvent, Comment, Project, Task


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ("key", "name", "tenant", "status", "owner", "is_archived")
    list_filter = ("status", "tenant__plan")
    search_fields = ("name", "key", "tenant__name")


@admin.register(Task)
class TaskAdmin(admin.ModelAdmin):
    list_display = ("reference", "title", "project", "status", "priority", "assignee", "due_date")
    list_filter = ("status", "priority", "project__tenant")
    search_fields = ("title", "reference")


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    list_display = ("task", "author", "created_at")
    search_fields = ("body", "task__title")


@admin.register(ActivityEvent)
class ActivityEventAdmin(admin.ModelAdmin):
    list_display = ("tenant", "verb", "object_type", "actor", "created_at")
    list_filter = ("verb", "object_type")
    search_fields = ("summary", "tenant__slug")
