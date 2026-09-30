# Orbit API - Multi-Tenant SaaS Project Management Backend

**Python 3.14** · Django 5.2 LTS · Django REST Framework 3.18 · PostgreSQL.

Every row of business data hangs off a `tenant`, and every request is scoped to
exactly one workspace before a single query runs.

| package | version | Python 3.14 |
| --- | --- | --- |
| Django | 5.2.17 | supported since 5.2.8 |
| djangorestframework | 3.18.1 | yes |
| django-filter | 26.1 | yes |
| drf-spectacular | 0.30.0 | yes |
| django-cors-headers | 4.9.0 | yes |
| psycopg[binary] | 3.3.6 | cp314 wheels published |

```
django/            # this project
  manage.py
  config/          settings · urls · wsgi · asgi
  common/          base models, pagination, permissions, throttling, tenant middleware
  apps/
    accounts/      custom email User, register / token / me, JWT tenant claims
    tenancy/       Tenant · Membership · Invitation (+ role permissions)
    work/          Project · Task · Comment · ActivityEvent (+ filters)
```

## Quick start

Requires **Python 3.14+** (built against 3.14.7). `config/settings.py` refuses to
boot on an older interpreter and prints the exact commands to rebuild your venv.

```bash
python3.14 -m venv .venv && source .venv/bin/activate
python --version                 # 3.14.7
pip install -r requirements.txt
cp .env.example .env

python manage.py migrate
python manage.py seed_demo
python manage.py runserver 8000
```

Or with Docker: `docker compose up --build`.

Demo logins (password `demo1234` for all):

| email | role in `northwind-labs` | role in `orbit-internal` |
| --- | --- | --- |
| `ada@orbit.dev` | owner | owner |
| `grace@orbit.dev` | admin | viewer |
| `linus@orbit.dev` | member | - |
| `margaret@orbit.dev` | viewer | - |

## Authentication

`djangorestframework-simplejwt` with custom claims. The access token carries the
active workspace so the tenancy middleware does not have to hit the database for
the default case:

```json
{
  "token_type": "access",
  "sub": "8f1c…",
  "email": "ada@orbit.dev",
  "tenant_id": "3d2b…",
  "tenant_slug": "northwind-labs",
  "role": "owner"
}
```

```bash
ACCESS=$(curl -s -X POST localhost:8000/api/auth/token/ \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@orbit.dev","password":"demo1234"}' | jq -r .access)

curl localhost:8000/api/tasks/ -H "Authorization: Bearer $ACCESS"
```

To work in a different workspace you belong to, keep the same token and send
`-H "X-Tenant-Slug: orbit-internal"`. Membership is re-verified on every request,
so revoking a seat takes effect immediately.

## Endpoints

| Method | Route | Roles | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/register/` | public | user + workspace + owner membership |
| POST | `/api/auth/token/` | public | access + refresh pair |
| POST | `/api/auth/token/refresh/` | public | rotates the refresh token |
| GET/PATCH | `/api/auth/me/` | any | profile + all workspaces |
| GET | `/api/tenants/` | any | workspaces you belong to |
| POST | `/api/tenants/` | any | new workspace, caller becomes owner |
| GET/PATCH | `/api/tenants/{id}/` | any / admin+ | settings, plan, usage |
| DELETE | `/api/tenants/{id}/` | owner | cascades the workspace |
| GET | `/api/members/` | any | roster + roles |
| POST | `/api/members/` | admin+ | adds a user **or** creates an invitation |
| PATCH/DELETE | `/api/members/{id}/` | admin+ | change role / revoke seat |
| GET | `/api/invitations/` | any | pending seats |
| GET | `/api/projects/` | any | `?status=&search=&archived=&limit=&offset=&ordering=` |
| POST | `/api/projects/` | member+ | plan quota + per-tenant key uniqueness |
| GET/PATCH | `/api/projects/{id}/` | any / member+ | |
| DELETE | `/api/projects/{id}/` | admin+ | |
| GET | `/api/projects/{id}/board/` | any | counts grouped by status |
| GET | `/api/tasks/` | any | `?project=&status=&priority=&assignee=me&unassigned=&search=&ordering=` |
| POST | `/api/tasks/` | member+ | per-project sequence → `WEB-12` |
| GET/PATCH | `/api/tasks/{id}/` | any / member+ | |
| DELETE | `/api/tasks/{id}/` | member+ | |
| GET/POST | `/api/tasks/{id}/comments/` | any | discussion thread |
| GET | `/api/activity/` | any | tenant audit trail |
| GET | `/api/summary/` | any | dashboard aggregates |
| GET | `/api/schema/` · `/api/docs/` | any | OpenAPI 3 + Swagger UI |

## How isolation works

1. `common.middleware.resolve_membership` runs inside
   `perform_authentication` - before `check_permissions` - and attaches
   `request.membership`, `request.tenant` and `request.role`. A user with no
   membership in the addressed workspace gets `403`, never a data leak.
2. Every viewset inherits `common.views.TenantScopedViewSet` and builds its
   queryset as `Model.objects.filter(tenant=request.tenant)`. Detail routes of
   another tenant therefore return `404`, exactly like a missing row.
3. Writes go through serializers that re-validate relationships against the
   active tenant (`assignee must be a member`, `project must belong to the
   workspace`), so body payloads cannot smuggle cross-tenant ids.
4. Plans are data: `max_projects` / `max_members` live on the tenant row and are
   checked in `validate()` → `400` with a readable `detail`.

## Tests

```bash
python manage.py test apps.work -v 2
```

`apps/work/tests.py` covers the cross-tenant 404s, the body-smuggling attempt,
role enforcement (viewer / member / admin / owner), free-plan quota and the
summary aggregation.

## Deployment notes

* `DATABASE_URL` is parsed into the Django `DATABASES` setting - no extra
  dependency needed.
* `gunicorn config.wsgi:application` for WSGI; `config.asgi` is wired for ASGI.
* Throttling is per tenant (`6000/h`) plus per IP for auth routes (`60/h`).
* Errors return a single envelope: `{"detail": "...", "code": "..."}` or a field
  map from DRF validation.
