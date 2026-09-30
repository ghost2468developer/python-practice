"""The tenant (workspace) and the rows that tie users to it."""
import uuid
from datetime import timedelta

from django.conf import settings as django_settings
from django.db import models
from django.utils import timezone

from common.models import Base
from common.utils import make_token, unique_slug


class Tenant(Base):
    """
    A workspace: the hard boundary of every query in the system.

    ``max_projects`` / ``max_members`` are denormalised from the plan so quota
    checks never require a pricing lookup table.
    """

    class Plan(models.TextChoices):
        FREE = "free", "Free"
        PRO = "pro", "Pro"
        BUSINESS = "business", "Business"

    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=63, unique=True)
    plan = models.CharField(max_length=16, choices=Plan.choices, default=Plan.FREE)
    billing_email = models.EmailField(blank=True, null=True)
    max_projects = models.PositiveIntegerField(default=3)
    max_members = models.PositiveIntegerField(default=5)
    settings = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["plan"])]

    def __str__(self):
        return f"{self.name} ({self.slug})"

    @property
    def plan_limits(self):
        return django_settings.TENANCY["PLANS"].get(self.plan, {})

    def apply_plan_limits(self):
        limits = self.plan_limits
        self.max_projects = limits.get("max_projects") or 1000
        self.max_members = limits.get("max_members") or 1000

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = unique_slug(self.name, type(self))
        super().save(*args, **kwargs)

    # -- usage helpers -----------------------------------------------------
    @property
    def members_count(self):
        return self.memberships.count()

    @property
    def projects_count(self):
        return self.projects.count()

    @property
    def seats_remaining(self):
        return max(self.max_members - self.members_count, 0)


class Membership(Base):
    """The single source of truth for "who can touch this workspace"."""

    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        ADMIN = "admin", "Admin"
        MEMBER = "member", "Member"
        VIEWER = "viewer", "Viewer"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(django_settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="membership_set")
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.MEMBER)
    is_default = models.BooleanField(default=False)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(fields=("tenant", "user"), name="unique_membership_per_tenant"),
        ]
        indexes = [
            models.Index(fields=["user"]),
            models.Index(fields=["tenant", "role"]),
        ]

    def __str__(self):
        return f"{self.user} @ {self.tenant.slug} as {self.role}"

    @property
    def rank(self):
        from common.permissions import ROLE_RANK

        return ROLE_RANK.get(self.role, 0)


class Invitation(Base):
    """A seat that has been reserved but not claimed yet."""

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REVOKED = "revoked", "Revoked"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="invitations")
    email = models.EmailField(max_length=254)
    role = models.CharField(max_length=16, choices=Membership.Role.choices, default=Membership.Role.MEMBER)
    token = models.CharField(max_length=64, unique=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    invited_by = models.ForeignKey(
        django_settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="invitations_sent"
    )
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=("tenant", "email"), name="unique_invitation_per_tenant"),
        ]

    def save(self, *args, **kwargs):
        if not self.token:
            self.token = make_token(32)
        if self.expires_at is None:
            self.expires_at = timezone.now() + timedelta(days=7)
        super().save(*args, **kwargs)

    @property
    def is_expired(self):
        return bool(self.expires_at and self.expires_at < timezone.now())

    def __str__(self):
        return f"{self.email} -> {self.tenant.slug} ({self.role})"
