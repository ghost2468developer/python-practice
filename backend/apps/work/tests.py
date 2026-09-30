"""
End-to-end tests focused on the thing that matters most in a multi-tenant SaaS:
**isolation**. A member of workspace A must never be able to read, update or
even confirm the existence of workspace B's rows.
"""
import uuid

from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APITestCase

from apps.tenancy.models import Membership, Tenant
from apps.work.models import Project, Task

User = get_user_model()


def auth(client, token):
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")
    return client


class TenancyTestCase(APITestCase):
    def setUp(self):
        self.password = "strong-password-1"
        self.owner_a = User.objects.create_user(email="owner@a.test", password=self.password, full_name="Owner A")
        self.member_a = User.objects.create_user(email="member@a.test", password=self.password, full_name="Member A")
        self.viewer_a = User.objects.create_user(email="viewer@a.test", password=self.password, full_name="Viewer A")
        self.owner_b = User.objects.create_user(email="owner@b.test", password=self.password, full_name="Owner B")

        self.tenant_a = Tenant.objects.create(name="Alpha", slug="alpha")
        self.tenant_b = Tenant.objects.create(name="Beta", slug="beta")

        Membership.objects.create(tenant=self.tenant_a, user=self.owner_a, role=Membership.Role.OWNER, is_default=True)
        Membership.objects.create(tenant=self.tenant_a, user=self.member_a, role=Membership.Role.MEMBER)
        Membership.objects.create(tenant=self.tenant_a, user=self.viewer_a, role=Membership.Role.VIEWER)
        Membership.objects.create(tenant=self.tenant_b, user=self.owner_b, role=Membership.Role.OWNER, is_default=True)

        self.project_a = Project.objects.create(tenant=self.tenant_a, name="Alpha Site", key="ALPHA", status=Project.Status.ACTIVE)
        self.project_b = Project.objects.create(tenant=self.tenant_b, name="Beta Site", key="BETA")
        self.task_a = Task.objects.create(
            tenant=self.tenant_a, project=self.project_a, title="Alpha task", reporter=self.owner_a, sequence=1
        )

    def login(self, user):
        response = self.client.post("/api/auth/token/", {"email": user.email, "password": self.password})
        return response.data["access"]


class AuthenticationTests(TenancyTestCase):
    def test_token_contains_tenant_claims(self):
        token = self.login(self.owner_a)
        self.assertIn("access", self.login(self.owner_a))
        # claims are readable without verifying the signature
        import base64
        import json

        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        self.assertEqual(claims["tenant_slug"], "alpha")
        self.assertEqual(claims["role"], "owner")

    def test_register_creates_user_and_workspace(self):
        response = self.client.post(
            "/api/auth/register/",
            {
                "full_name": "New User",
                "email": "new@user.test",
                "password": "another-strong-1",
                "workspace_name": "New Co",
            },
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["workspace"]["slug"], "new-co")
        self.assertTrue(Tenant.objects.filter(slug="new-co").exists())


class TenantIsolationTests(TenancyTestCase):
    def test_cannot_read_other_tenant_project(self):
        token = self.login(self.owner_b)
        auth(self.client, token)
        response = self.client.get(f"/api/projects/{self.project_a.id}/", HTTP_X_TENANT_SLUG="beta")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_write_into_other_tenant(self):
        token = self.login(self.owner_b)
        auth(self.client, token)
        response = self.client.post(
            "/api/tasks/",
            {"project": str(self.project_a.id), "title": "Hostile task"},
            HTTP_X_TENANT_SLUG="beta",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cannot_patch_other_tenant_task(self):
        token = self.login(self.owner_b)
        auth(self.client, token)
        response = self.client.patch(
            f"/api/tasks/{self.task_a.id}/",
            {"status": "done"},
            HTTP_X_TENANT_SLUG="beta",
        )
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.task_a.refresh_from_db()
        self.assertEqual(self.task_a.status, Task.Status.TODO)

    def test_non_member_is_rejected(self):
        stranger = User.objects.create_user(email="stranger@x.test", password=self.password, full_name="S")
        token = self.login(stranger)
        auth(self.client, token)
        response = self.client.get("/api/projects/", HTTP_X_TENANT_SLUG="alpha")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_uuid_guessing_does_not_leak(self):
        token = self.login(self.owner_b)
        auth(self.client, token)
        fake = uuid.uuid4()
        response = self.client.get(f"/api/projects/{fake}/", HTTP_X_TENANT_SLUG="beta")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)


class RoleTests(TenancyTestCase):
    def test_viewer_cannot_create_tasks(self):
        token = self.login(self.viewer_a)
        auth(self.client, token)
        response = self.client.post(
            "/api/tasks/", {"project": str(self.project_a.id), "title": "Nope"}, HTTP_X_TENANT_SLUG="alpha"
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_member_cannot_invite(self):
        token = self.login(self.member_a)
        auth(self.client, token)
        response = self.client.post(
            "/api/members/", {"email": "someone@x.test"}, HTTP_X_TENANT_SLUG="alpha"
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_cannot_delete_project(self):
        admin = User.objects.create_user(email="admin@a.test", password=self.password, full_name="Admin A")
        Membership.objects.create(tenant=self.tenant_a, user=admin, role=Membership.Role.ADMIN)
        token = self.login(admin)
        auth(self.client, token)
        response = self.client.delete(f"/api/projects/{self.project_a.id}/", HTTP_X_TENANT_SLUG="alpha")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class PlanQuotaTests(TenancyTestCase):
    def test_free_plan_limits_projects(self):
        token = self.login(self.owner_a)
        auth(self.client, token)
        for index in range(2):  # tenant already holds one project
            response = self.client.post(
                "/api/projects/", {"name": f"Project {index}"}, HTTP_X_TENANT_SLUG="alpha"
            )
            self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        response = self.client.post("/api/projects/", {"name": "One too many"}, HTTP_X_TENANT_SLUG="alpha")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("detail", response.data)


class WorkflowTests(TenancyTestCase):
    def test_task_crud_and_comments(self):
        token = self.login(self.member_a)
        auth(self.client, token)

        created = self.client.post(
            "/api/tasks/",
            {"project": str(self.project_a.id), "title": "Ship it", "priority": "high"},
            HTTP_X_TENANT_SLUG="alpha",
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        self.assertEqual(created.data["reference"], "ALPHA-2")

        task_id = created.data["id"]
        commented = self.client.post(
            f"/api/tasks/{task_id}/comments/", {"body": "On it"}, HTTP_X_TENANT_SLUG="alpha"
        )
        self.assertEqual(commented.status_code, status.HTTP_201_CREATED)

        moved = self.client.patch(f"/api/tasks/{task_id}/", {"status": "done"}, HTTP_X_TENANT_SLUG="alpha")
        self.assertEqual(moved.data["status"], "done")
        self.assertIsNotNone(moved.data["completed_at"])

        activity = self.client.get("/api/activity/", HTTP_X_TENANT_SLUG="alpha")
        verbs = [item["verb"] for item in activity.data["results"]]
        self.assertIn("created_task", verbs)
        self.assertIn("commented", verbs)

    def test_summary_is_scoped(self):
        token = self.login(self.owner_a)
        auth(self.client, token)
        response = self.client.get("/api/summary/", HTTP_X_TENANT_SLUG="alpha")
        self.assertEqual(response.data["totals"]["tasks"], 1)
