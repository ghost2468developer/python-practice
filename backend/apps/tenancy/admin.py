from django.contrib import admin

from .models import Invitation, Membership, Tenant


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0


@admin.register(Tenant)
class TenantAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "plan", "max_projects", "max_members", "created_at")
    search_fields = ("name", "slug")
    list_filter = ("plan",)
    inlines = [MembershipInline]


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("user", "tenant", "role", "is_default", "created_at")
    list_filter = ("role", "tenant__plan")
    search_fields = ("user__email", "tenant__name")


@admin.register(Invitation)
class InvitationAdmin(admin.ModelAdmin):
    list_display = ("email", "tenant", "role", "status", "expires_at")
    list_filter = ("status", "role")
    search_fields = ("email", "tenant__name")
