# Orbit - Multi-Tenant SaaS Project Management API

A complete **Django 5 + Django REST Framework + PostgreSQL** backend where every
project, task, comment and audit row belongs to a *workspace* (tenant), plus a
**JavaScript-only** live mirror of the same contract that runs in the preview so
you can click through every endpoint from the browser.

```
backend/                  ← the real thing: Python / Django / DRF / PostgreSQL
src/                      ← JavaScript mirror (no TypeScript) + docs UI
  app/api/**/route.js     same routes, same payloads, same status codes
  lib/{auth,tenancy,http,serializers}.js   JWT · RBAC · DRF-style errors
  components/ApiConsole.jsx                interactive explorer (the page)
```

## 1. Run the Django backend

Requires **Python 3.14+** (built against `3.14.7`). Every pinned dependency
declares 3.14 support - Django from 5.2.8, and psycopg publishes cp314 wheels so
nothing compiles from source. `config/settings.py` refuses to boot on an older
interpreter and prints the commands to rebuild your venv.

```bash
cd backend
python3.14 -m venv .venv && source .venv/bin/activate
python --version          # 3.14.7
pip install -r requirements.txt
cp .env.example .env

python manage.py migrate
python manage.py seed_demo
python manage.py runserver 8000
```

Swagger UI: <http://localhost:8000/api/docs/> · OpenAPI: `/api/schema/`
Docker: `docker compose up --build` from `backend/`.

## 2. Try it from the browser

The deployed preview renders a console at `/`:

1. sign in with `ada@orbit.dev` / `demo1234` (one click - the four demo roles are listed),
2. switch workspace (`X-Tenant-Slug`) and watch the dataset change while the JWT stays identical,
3. fire any endpoint; ids captured from list responses pre-fill detail routes,
4. “Prove tenant isolation” queries both workspaces with the same token.

Demo accounts (password `demo1234`):

| email | northwind-labs | orbit-internal |
| --- | --- | --- |
| `ada@orbit.dev` | owner | owner |
| `grace@orbit.dev` | admin | viewer |
| `linus@orbit.dev` | member | - |
| `margaret@orbit.dev` | viewer | - |

## API surface

| Method | Route | Roles |
| --- | --- | --- |
| POST | `/api/auth/register/` | public |
| POST | `/api/auth/token/` · `/api/auth/token/refresh/` | public |
| GET/PATCH | `/api/auth/me/` | any |
| GET/POST | `/api/tenants/` | any |
| GET/PATCH/DELETE | `/api/tenants/{id}/` | any / admin / owner |
| GET/POST | `/api/members/` | any / admin |
| PATCH/DELETE | `/api/members/{id}/` | admin |
| GET | `/api/projects/` · POST | any / member |
| GET/PATCH/DELETE | `/api/projects/{id}/` | any / member / admin |
| GET | `/api/tasks/` · POST | any / member |
| GET/PATCH/DELETE | `/api/tasks/{id}/` | any / member |
| GET/POST | `/api/tasks/{id}/comments/` | any |
| GET | `/api/activity/` · `/api/summary/` | any |
| GET | `/api/health/` | public |

### Tenancy rules that are enforced server side

* The workspace is resolved from the JWT claim **or** `X-Tenant-Slug`, then the
  membership is re-verified - revoking a seat cuts access instantly.
* Querysets are filtered by `tenant_id` *inside* the query, so cross-tenant ids
  return `404`, never data.
* Related objects are re-validated against the active tenant (assignee must be a
  member, project must belong to the workspace) so payloads can't smuggle ids.
* Plans are data: `free` 3 projects / 5 seats, `pro` 25 / 25, `business`
  unlimited → exceeded quotas return `409` with a readable `detail`.
* Roles: `viewer` (read + comment) → `member` (work) → `admin` (team) →
  `owner` (billing, plan, delete workspace).

### Errors

```json
{"detail": "Plan \"free\" allows 3 projects. Upgrade the workspace to add more.", "code": "conflict"}
{"key": ["Project keys must be unique inside a workspace."]}
{"detail": "Requires one of the following roles: owner, admin, member. Your role is \"viewer\".", "code": "permission_denied"}
```

## Tests

`backend/apps/work/tests.py` proves the isolation guarantees: cross-tenant reads
return 404, cross-tenant writes 400, non-members 403, viewers cannot write, only
owners change plans, free-plan quota trips, and the task board + comments work
end to end.

```bash
cd backend && python manage.py test apps.work -v 2
```
