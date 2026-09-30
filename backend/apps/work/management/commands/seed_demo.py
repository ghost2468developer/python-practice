"""Loads the demo dataset: two isolated workspaces sharing the same users."""
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.tenancy.models import Membership, Tenant
from apps.work.models import ActivityEvent, Comment, Project, Task

User = get_user_model()

DEMO_PASSWORD = "demo1234"


class Command(BaseCommand):
    help = "Create demo workspaces, projects, tasks and comments (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true", help="Recreate the dataset even if it already exists.")

    def handle(self, *args, **options):
        if User.objects.filter(email="ada@orbit.dev").exists() and not options["force"]:
            self.stdout.write(self.style.WARNING("Demo data already present - nothing to do."))
            return

        people = [
            ("ada@orbit.dev", "Ada Lovelace"),
            ("grace@orbit.dev", "Grace Hopper"),
            ("linus@orbit.dev", "Linus Berg"),
            ("margaret@orbit.dev", "Margaret Hamilton"),
        ]
        users = {}
        for email, full_name in people:
            user, _ = User.objects.get_or_create(
                email=email, defaults={"full_name": full_name}
            )
            user.set_password(DEMO_PASSWORD)
            user.full_name = full_name
            user.save()
            users[email] = user

        ada = users["ada@orbit.dev"]
        grace = users["grace@orbit.dev"]
        linus = users["linus@orbit.dev"]
        margaret = users["margaret@orbit.dev"]

        northwind = Tenant.objects.create(
            name="Northwind Labs",
            slug="northwind-labs",
            plan=Tenant.Plan.PRO,
            billing_email=ada.email,
            max_projects=25,
            max_members=25,
            settings={"timezone": "Europe/Berlin", "feature_flags": {"board_swimlanes": True}},
        )
        internal = Tenant.objects.create(
            name="Orbit Internal",
            slug="orbit-internal",
            plan=Tenant.Plan.FREE,
            billing_email=ada.email,
            max_projects=3,
            max_members=5,
            settings={"timezone": "UTC"},
        )

        Membership.objects.create(tenant=northwind, user=ada, role=Membership.Role.OWNER, is_default=True)
        Membership.objects.create(tenant=northwind, user=grace, role=Membership.Role.ADMIN)
        Membership.objects.create(tenant=northwind, user=linus, role=Membership.Role.MEMBER)
        Membership.objects.create(tenant=northwind, user=margaret, role=Membership.Role.VIEWER)
        Membership.objects.create(tenant=internal, user=ada, role=Membership.Role.OWNER, is_default=True)
        Membership.objects.create(tenant=internal, user=grace, role=Membership.Role.VIEWER)

        projects = {
            key: Project.objects.create(tenant=tenant, name=name, key=key, description=description, status=status, owner=owner)
            for key, tenant, name, description, status, owner in [
                ("WEB", northwind, "Website Relaunch", "Rebuild the marketing site on a headless stack.", Project.Status.ACTIVE, ada),
                ("APP", northwind, "Mobile App v2", "Offline-first rewrite of the mobile clients.", Project.Status.PLANNING, grace),
                ("DATA", northwind, "Data Platform", "Warehouse, ingestion and reporting layer.", Project.Status.ON_HOLD, ada),
                ("OPS", internal, "Internal Tooling", "Everything ops needs to keep the lights on.", Project.Status.ACTIVE, ada),
            ]
        }

        task_specs = [
            ("WEB", "Refresh marketing homepage", Task.Status.DONE, Task.Priority.HIGH, linus, 5, 1),
            ("WEB", "Migrate CMS to headless backend", Task.Status.IN_PROGRESS, Task.Priority.URGENT, grace, 8, 2),
            ("WEB", "Design system audit", Task.Status.TODO, Task.Priority.MEDIUM, margaret, 3, 3),
            ("WEB", "Set a performance budget for LCP", Task.Status.BACKLOG, Task.Priority.LOW, ada, 3, 4),
            ("APP", "Offline sync prototype", Task.Status.IN_PROGRESS, Task.Priority.URGENT, linus, 13, 1),
            ("APP", "Push notification service", Task.Status.TODO, Task.Priority.HIGH, ada, 5, 2),
            ("APP", "App store listing copy", Task.Status.BACKLOG, Task.Priority.LOW, None, 1, 3),
            ("DATA", "Warehouse schema v2", Task.Status.BLOCKED, Task.Priority.HIGH, grace, 8, 1),
            ("DATA", "Retention policy backfill", Task.Status.TODO, Task.Priority.MEDIUM, linus, 5, 2),
            ("DATA", "Executive dashboard Q3", Task.Status.DONE, Task.Priority.MEDIUM, margaret, 3, 3),
            ("OPS", "Vendor contract tracker", Task.Status.IN_PROGRESS, Task.Priority.MEDIUM, ada, 3, 1),
            ("OPS", "Onboarding checklist automation", Task.Status.TODO, Task.Priority.LOW, grace, 2, 2),
        ]

        tasks = []
        for index, (key, title, task_status, priority, assignee, points, sequence) in enumerate(task_specs):
            tasks.append(
                Task.objects.create(
                    tenant=projects[key].tenant,
                    project=projects[key],
                    title=title,
                    description=f"Seeded task for the {projects[key].name} project.",
                    status=task_status,
                    priority=priority,
                    assignee=assignee,
                    reporter=ada,
                    sequence=sequence or index + 1,
                    story_points=points,
                    due_date=timezone.now() + timedelta(days=(index % 14) + 3),
                    completed_at=timezone.now() - timedelta(hours=12) if task_status == Task.Status.DONE else None,
                )
            )

        Comment.objects.create(
            tenant=northwind,
            task=tasks[1],
            author=ada,
            body="Content freeze starts Friday - land copy changes before then.",
        )
        Comment.objects.create(
            tenant=northwind,
            task=tasks[1],
            author=grace,
            body="Migration dry run finished with 0 broken slugs. Ready for cutover.",
        )
        Comment.objects.create(
            tenant=northwind,
            task=tasks[4],
            author=linus,
            body="Conflict resolution now prefers the newest server write.",
        )

        ActivityEvent.objects.create(
            tenant=northwind, actor=ada, verb="created_project", object_type="project", object_id=projects["WEB"].id,
            summary="Ada Lovelace created the project Website Relaunch",
        )
        ActivityEvent.objects.create(
            tenant=northwind, actor=grace, verb="updated_task", object_type="task", object_id=tasks[1].id,
            summary="Grace Hopper moved WEB-2 to in progress",
        )
        ActivityEvent.objects.create(
            tenant=internal, actor=ada, verb="created_project", object_type="project", object_id=projects["OPS"].id,
            summary="Ada Lovelace created the project Internal Tooling",
        )

        self.stdout.write(self.style.SUCCESS("Demo dataset created."))
        self.stdout.write("  login: ada@orbit.dev / demo1234")
        self.stdout.write(f"  tenants: {', '.join([northwind.slug, internal.slug])}")
