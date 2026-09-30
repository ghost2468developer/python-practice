"""Abstract base models shared by every app."""
import uuid

from django.db import models


class UUIDModel(models.Model):
    """UUID primary keys keep ids non-guessable across tenants."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Base(UUIDModel, TimeStampedModel):
    class Meta:
        abstract = True
