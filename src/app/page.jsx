import ApiConsole from "@/components/ApiConsole";
import { PINNED } from "@/lib/endpoints";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

const TENANCY_LAYERS = [
  {
    title: "1 · Tenant is a first-class row",
    body: "Every workspace is a `tenants` row with its own slug, plan, seat/project quotas and settings. Users never belong to a tenant directly — they reach it through a `memberships` row that carries the role.",
    tag: "tenancy.Tenant",
  },
  {
    title: "2 · Identity carries the workspace",
    body: "The JWT access token embeds `tenant_id`, `tenant_slug` and `role`. A client can address any other workspace it belongs to by sending `X-Tenant-Slug`; the server re-verifies membership on every request.",
    tag: "SimpleJWT + custom claims",
  },
  {
    title: "3 · Querysets are scoped, not filtered in views",
    body: "Each viewset builds its queryset from `request.tenant.id`. There is no way to express “give me another tenant's project” — the filter is part of the queryset, so detail routes 404 instead of leaking.",
    tag: "get_queryset()",
  },
  {
    title: "4 · Roles and plan limits gate writes",
    body: "`viewer` reads, `member` edits work, `admin` manages the team, `owner` owns billing and deletion. Seat and project quotas come from the plan and are checked in the serializer's validate() step.",
    tag: "DRF permissions",
  },
];

const RBAC = [
  ["List / retrieve projects, tasks, activity", "yes", "yes", "yes", "yes"],
  ["Comment on a task", "yes", "yes", "yes", "yes"],
  ["Create / update / delete tasks", "yes", "yes", "yes", "no"],
  ["Create / update projects", "yes", "yes", "yes", "no"],
  ["Delete projects", "yes", "yes", "no", "no"],
  ["Invite members, change roles", "yes", "yes", "no", "no"],
  ["Change plan, billing email, delete workspace", "yes", "no", "no", "no"],
];

const MODEL_ROWS = [
  ["tenants", "id, name, slug ᵘ, plan, billing_email, max_projects, max_members, settings, timestamps", "The tenant. Cascade-owns everything below."],
  ["users", "id, email ᵘ, full_name, password_hash, is_active, date_joined", "Global identity — shared across tenants."],
  ["memberships", "id, tenant_id →, user_id →, role, is_default ᵘ(tenant,user)", "The join table that makes multi-tenancy possible."],
  ["invitations", "id, tenant_id →, email, role, token, status, expires_at", "Pending seat before the teammate signs up."],
  ["projects", "id, tenant_id →, name, key ᵘ(tenant,key), status, owner_id →, due_date", "Project keys are unique per tenant, not globally."],
  ["tasks", "id, tenant_id →, project_id →, title, status, priority, assignee_id →, sequence", "Denormalised tenant_id keeps every filter one-index deep."],
  ["comments", "id, tenant_id →, task_id →, author_id →, body", "Threaded discussion on a task."],
  ["activity_events", "id, tenant_id →, actor_id →, verb, object_type, object_id, summary, metadata", "Audit trail, scoped per tenant."],
];

const TREE = `backend/
├── manage.py
├── requirements.txt
├── config/            # settings.py · urls.py · wsgi.py · asgi.py
└── apps/
    ├── accounts/      # custom User, register/login/me, JWT claims
    ├── tenancy/       # Tenant, Membership, Invitation + role permissions
    ├── work/          # Project, Task, Comment, ActivityEvent + filters
    └── common/        # base models, pagination, permissions, throttles`;

const SETUP = `# 1 — install (Python 3.14+)
python3.14 -m venv .venv && source .venv/bin/activate
python --version          # 3.14.7
pip install -r backend/requirements.txt

# 2 — configure (or export the variables directly)
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/app_db
export DJANGO_SECRET_KEY=$(openssl rand -hex 32)
export DJANGO_DEBUG=1

# 3 — migrate, seed, run
python backend/manage.py migrate
python backend/manage.py seed_demo
python backend/manage.py runserver 8000

# 4 — exercise the API
curl -X POST localhost:8000/api/auth/token/ \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"ada@orbit.dev","password":"demo1234"}'

curl localhost:8000/api/tasks/ -H "Authorization: Bearer $ACCESS" \\
  -H "X-Tenant-Slug: northwind-labs"`;

const MAPPING = [
  ["accounts.views.RegisterView", "POST /api/auth/register/", "CreateAPIView — user + tenant + owner membership"],
  ["accounts.views.LoginView", "POST /api/auth/token/", "TokenObtainPairView with tenant claims"],
  ["accounts.views.MeView", "GET/PATCH /api/auth/me/", "RetrieveUpdateAPIView"],
  ["tenancy.views.TenantViewSet", "/api/tenants/", "ModelViewSet, IsTenantMember + OwnerOnly destroy"],
  ["tenancy.views.MembershipViewSet", "/api/members/", "ModelViewSet with seat-limit validation"],
  ["work.views.ProjectViewSet", "/api/projects/", "ModelViewSet + DjangoFilterBackend + SearchFilter"],
  ["work.views.TaskViewSet", "/api/tasks/", "ModelViewSet + OrderingFilter + prefetch comments"],
  ["work.views.CommentViewSet", "/api/tasks/{id}/comments/", "Nested Router + IsTenantMember"],
  ["work.views.ActivityViewSet", "/api/activity/", "ReadOnlyModelViewSet, tenant scoped audit"],
  ["common.pagination.DefaultPagination", "?limit=&offset=", "LimitOffsetPagination"],
];

function Badge({ children }) {
  return (
    <span className="rounded-full border border-indigo-400/30 bg-indigo-500/10 px-3 py-1 text-[11px] font-medium text-indigo-200">
      {children}
    </span>
  );
}

function Section({ id, title, kicker, children }) {
  return (
    <section id={id} className="space-y-4">
      <div>
        {kicker ? (
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-300/80">{kicker}</p>
        ) : null}
        <h2 className="mt-1 text-xl font-semibold text-slate-100 sm:text-2xl">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export default async function Home() {
  const seed = await ensureSeed();

  return (
    <main className="grid-bg min-h-screen">
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 lg:py-14">
        {/* Hero */}
        <header className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500 text-lg font-black text-white shadow-lg shadow-indigo-500/30">
              O
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight text-slate-100">Orbit API</p>
              <p className="text-[11px] text-slate-400">Multi-tenant SaaS project management backend</p>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <Badge>Python 3.14</Badge>
              <Badge>Django 5.2 LTS</Badge>
              <Badge>Django REST Framework</Badge>
              <Badge>PostgreSQL</Badge>
              <Badge>SimpleJWT</Badge>
              <Badge>Zero TypeScript</Badge>
            </div>
          </div>

          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl lg:text-5xl">
              One backend, thousands of isolated workspaces.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-slate-300">
              A complete Django + DRF + PostgreSQL implementation of a multi-tenant project management API: workspace
              membership and roles, JWT authentication with tenant claims, plan quotas, nested task boards, comments and a
              per-tenant audit trail. Everything below is live — this page runs a{" "}
              <span className="text-slate-100">byte-compatible JavaScript mirror</span> of the Django serializers so you can
              fire real requests from the browser, and the full Django project ships in{" "}
              <span className="mono text-indigo-200">backend/</span>.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-400">
              <span className="rounded-md border border-slate-700/70 bg-slate-900/60 px-2 py-1">
                seed: {seed.created ? "created" : "already loaded"}
              </span>
              <span className="rounded-md border border-slate-700/70 bg-slate-900/60 px-2 py-1">
                demo login <span className="mono text-slate-200">ada@orbit.dev / demo1234</span>
              </span>
              <span className="rounded-md border border-slate-700/70 bg-slate-900/60 px-2 py-1">
                two tenants share these users on purpose
              </span>
            </div>
          </div>
        </header>

        {/* Live console */}
        <div className="mt-10">
          <Section id="console" kicker="Live" title="Interactive API console">
            <p className="max-w-3xl text-[13.5px] leading-relaxed text-slate-400">
              Sign in, switch workspace, pick an endpoint and send it. Ids are captured automatically from list responses so
              detail routes pre-fill themselves.
            </p>
          </Section>
          <div className="mt-5">
            <ApiConsole />
          </div>
        </div>

        {/* Tenancy model */}
        <div className="mt-14">
          <Section kicker="Architecture" title="How tenant isolation is enforced">
            <div className="grid gap-4 md:grid-cols-2">
              {TENANCY_LAYERS.map((layer) => (
                <article key={layer.title} className="card p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-slate-100">{layer.title}</h3>
                    <span className="mono shrink-0 rounded-md border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
                      {layer.tag}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{layer.body}</p>
                </article>
              ))}
            </div>
          </Section>
        </div>

        {/* RBAC */}
        <div className="mt-14">
          <Section kicker="Authorisation" title="Role matrix">
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[42rem] text-left text-[13px]">
                <thead className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-3 font-medium">Capability</th>
                    <th className="px-3 py-3 font-medium">Owner</th>
                    <th className="px-3 py-3 font-medium">Admin</th>
                    <th className="px-3 py-3 font-medium">Member</th>
                    <th className="px-3 py-3 font-medium">Viewer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {RBAC.map((row) => (
                    <tr key={row[0]} className="text-slate-300">
                      <td className="px-5 py-2.5">{row[0]}</td>
                      {row.slice(1).map((cell, index) => (
                        <td key={index} className="px-3 py-2.5">
                          <span
                            className={
                              cell === "yes"
                                ? "text-emerald-300"
                                : "text-slate-600"
                            }
                          >
                            {cell === "yes" ? "allowed" : "blocked"}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12.5px] text-slate-500">
              Plans: <span className="mono text-slate-300">free</span> 3 projects / 5 seats ·{" "}
              <span className="mono text-slate-300">pro</span> 25 / 25 ·{" "}
              <span className="mono text-slate-300">business</span> unlimited. Quotas are enforced server side and surface as{" "}
              <span className="mono">409 Conflict</span> with a human readable detail.
            </p>
          </Section>
        </div>

        {/* Data model */}
        <div className="mt-14">
          <Section kicker="PostgreSQL" title="Data model">
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[52rem] text-left text-[13px]">
                <thead className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-3 font-medium">Table</th>
                    <th className="px-3 py-3 font-medium">Columns</th>
                    <th className="px-3 py-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {MODEL_ROWS.map((row) => (
                    <tr key={row[0]}>
                      <td className="mono px-5 py-2.5 text-indigo-200">{row[0]}</td>
                      <td className="mono px-3 py-2.5 text-[11.5px] text-slate-400">{row[1]}</td>
                      <td className="px-3 py-2.5 text-slate-300">{row[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-slate-500">ᵘ = unique · → = foreign key with on-delete cascade</p>
          </Section>
        </div>

        {/* Django backend */}
        <div className="mt-14 grid gap-6 lg:grid-cols-2">
          <Section kicker="Python" title="Run the Django project">
            <div className="card p-5">
              <div className="mb-3 flex flex-wrap gap-1.5">
                {Object.entries(PINNED).map(([pkg, version]) => (
                  <span
                    key={pkg}
                    className="mono rounded-md border border-slate-700/70 bg-slate-950/50 px-2 py-1 text-[10.5px] text-slate-300"
                  >
                    {pkg}
                    <span className="text-indigo-300"> {version}</span>
                  </span>
                ))}
              </div>
              <pre className="mono overflow-auto text-[11.5px] leading-relaxed text-slate-300">{SETUP}</pre>
              <p className="mt-3 text-[12.5px] leading-relaxed text-slate-400">
                Every pin declares Python 3.14 support — Django gained it in 5.2.8, and psycopg publishes cp314 wheels so
                nothing compiles from source.{" "}
                <span className="mono text-slate-200">config/settings.py</span> refuses to boot on an older interpreter and
                prints the commands to rebuild your virtualenv.
              </p>
            </div>
          </Section>

          <Section kicker="Layout" title="Project structure">
            <div className="card p-5">
              <pre className="mono overflow-auto text-[11.5px] leading-relaxed text-slate-300">{TREE}</pre>
              <ul className="mt-3 space-y-1.5 text-[12.5px] text-slate-400">
                <li>
                  <span className="mono text-slate-200">config/settings.py</span> — env driven, CORS, throttling,
                  SimpleJWT lifetimes, drf-spectacular schema.
                </li>
                <li>
                  <span className="mono text-slate-200">common/permissions.py</span> —{" "}
                  <span className="mono">IsTenantMember</span>, <span className="mono">RoleRequired</span>,{" "}
                  <span className="mono">IsTenantOwner</span>.
                </li>
                <li>
                  <span className="mono text-slate-200">apps/work/tests.py</span> — cross-tenant isolation tests that prove
                  one tenant can never read or write another&apos;s rows.
                </li>
              </ul>
            </div>
          </Section>
        </div>

        {/* Mapping */}
        <div className="mt-14">
          <Section kicker="Parity" title="DRF class → live route">
            <div className="card overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-[13px]">
                <thead className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-5 py-3 font-medium">Django class</th>
                    <th className="px-3 py-3 font-medium">Route</th>
                    <th className="px-3 py-3 font-medium">Implementation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {MAPPING.map((row) => (
                    <tr key={row[0]}>
                      <td className="mono px-5 py-2.5 text-emerald-200">{row[0]}</td>
                      <td className="mono px-3 py-2.5 text-slate-300">{row[1]}</td>
                      <td className="px-3 py-2.5 text-slate-400">{row[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>

        <footer className="mt-16 border-t border-slate-800 pt-6 text-[12px] text-slate-500">
          Orbit API · Django REST Framework + PostgreSQL reference backend · JavaScript mirror served by this page for live
          exploration.
        </footer>
      </div>
    </main>
  );
}
