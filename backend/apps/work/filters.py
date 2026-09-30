"""django-filter FilterSets. Every filter is applied on top of an already
tenant-scoped queryset, so filtering can never widen the visible rows."""
import django_filters
from django.db.models import Q

from .models import ActivityEvent, Project, Task


class ProjectFilter(django_filters.FilterSet):
    status = django_filters.ChoiceFilter(choices=Project.Status.choices)
    is_archived = django_filters.BooleanFilter(field_name="is_archived")
    search = django_filters.CharFilter(method="filter_search")

    class Meta:
        model = Project
        fields = ("status", "is_archived", "search")

    def filter_search(self, queryset, name, value):
        term = value.strip()
        if not term:
            return queryset
        return queryset.filter(
            Q(name__icontains=term) | Q(key__icontains=term) | Q(description__icontains=term)
        )


class TaskFilter(django_filters.FilterSet):
    project = django_filters.UUIDFilter(field_name="project_id")
    status = django_filters.ChoiceFilter(choices=Task.Status.choices)
    priority = django_filters.ChoiceFilter(choices=Task.Priority.choices)
    assignee = django_filters.CharFilter(method="filter_assignee")
    unassigned = django_filters.BooleanFilter(method="filter_unassigned")
    search = django_filters.CharFilter(method="filter_search")

    class Meta:
        model = Task
        fields = ("project", "status", "priority", "assignee", "unassigned", "search")

    def filter_assignee(self, queryset, name, value):
        if value == "me":
            return queryset.filter(assignee_id=self.request.user.id)
        return queryset.filter(assignee_id=value)

    def filter_unassigned(self, queryset, name, value):
        if value:
            return queryset.filter(assignee__isnull=True)
        return queryset

    def filter_search(self, queryset, name, value):
        term = value.strip()
        if not term:
            return queryset
        return queryset.filter(Q(title__icontains=term) | Q(description__icontains=term))


class ActivityFilter(django_filters.FilterSet):
    verb = django_filters.CharFilter(lookup_expr="iexact")
    object_type = django_filters.CharFilter(field_name="object_type")

    class Meta:
        model = ActivityEvent
        fields = ("verb", "object_type")
