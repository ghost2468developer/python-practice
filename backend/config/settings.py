"""
Django settings for the Orbit multi-tenant SaaS API.

Everything is driven by environment variables so the same settings module works
locally, in Docker and on a PaaS.
"""
import os
import platform
import sys
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse

import dotenv

# ---------------------------------------------------------------------------
# Interpreter requirement - this project targets CPython 3.14 (built on 3.14.7).
# Settings is imported by *every* entrypoint (manage.py, wsgi, asgi, gunicorn),
# so an old virtualenv fails here with an actionable message.
# ---------------------------------------------------------------------------
REQUIRED_PYTHON = (3, 14)

if sys.version_info[:2] < REQUIRED_PYTHON:
    raise RuntimeError(
        f"Orbit API requires Python {REQUIRED_PYTHON[0]}.{REQUIRED_PYTHON[1]} or newer "
        f"(found {platform.python_version()}).\n"
        "  pyenv:  pyenv install 3.14 && pyenv local 3.14\n"
        "  then recreate the virtualenv and reinstall:\n"
        "          rm -rf .venv && python3.14 -m venv .venv && source .venv/bin/activate\n"
        "          pip install -r requirements.txt"
    )

BASE_DIR = Path(__file__).resolve().parent.parent
dotenv.load_dotenv(BASE_DIR / ".env")

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "django-insecure-change-me-in-production")
DEBUG = os.environ.get("DJANGO_DEBUG", "0").lower() in {"1", "true", "yes"}
ALLOWED_HOSTS = [
    host.strip() for host in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,0.0.0.0").split(",") if host.strip()
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # third party
    "rest_framework",
    "rest_framework_simplejwt",
    "django_filters",
    "corsheaders",
    "drf_spectacular",
    # local
    "common", # change made here
    "apps.accounts",
    "apps.tenancy",
    "apps.work",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "common.middleware.AuditContextMiddleware", # change made here
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]


def _database_from_url(raw_url: str) -> dict:
    parsed = urlparse(raw_url)
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": (parsed.path or "/").lstrip("/") or "app_db",
        "USER": parsed.username or "postgres",
        "PASSWORD": parsed.password or "",
        "HOST": parsed.hostname or "127.0.0.1",
        "PORT": str(parsed.port or 5432),
        "CONN_MAX_AGE": 60,
    }


DATABASES = {
    "default": _database_from_url(
        os.environ.get("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/app_db")
    )
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

AUTH_USER_MODEL = "accounts.User"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ("rest_framework_simplejwt.authentication.JWTAuthentication",),
    "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.IsAuthenticated",),
    "DEFAULT_PAGINATION_CLASS": "common.pagination.DefaultPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_FILTER_BACKENDS": (
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ),
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": ("common.throttling.TenantScopedThrottle",),
    "DEFAULT_THROTTLE_RATES": {"tenant": "6000/hour", "auth": "60/hour"},
    "EXCEPTION_HANDLER": "common.exceptions.exception_handler",
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=60),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "ROTATE_REFRESH_TOKENS": True,
    "BLACKLIST_AFTER_ROTATION": False,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": SECRET_KEY,
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "sub",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Orbit API",
    "DESCRIPTION": "Multi-tenant SaaS project management API built with Django REST Framework.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
}

# ---------------------------------------------------------------------------
# Multi-tenancy configuration - read by common/permissions.py and the viewsets.
# ---------------------------------------------------------------------------
TENANCY = {
    "TENANT_HEADER": "HTTP_X_TENANT_SLUG",
    "PLANS": {
        "free": {"max_projects": 3, "max_members": 5},
        "pro": {"max_projects": 25, "max_members": 25},
        "business": {"max_projects": None, "max_members": None},
    },
    "ROLES": ("owner", "admin", "member", "viewer"),
    "WRITE_ROLES": ("owner", "admin", "member"),
    "ADMIN_ROLES": ("owner", "admin"),
}

CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("CORS_ALLOWED_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]
CORS_ALLOW_CREDENTIALS = True
