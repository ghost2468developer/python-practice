from rest_framework.routers import DefaultRouter

from .views import ActivityViewSet, ProjectViewSet, SummaryViewSet, TaskViewSet

router = DefaultRouter()
router.register("projects", ProjectViewSet, basename="project")
router.register("tasks", TaskViewSet, basename="task")
router.register("activity", ActivityViewSet, basename="activity")
router.register("summary", SummaryViewSet, basename="summary")

urlpatterns = router.urls
