"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, ENDPOINTS, METHOD_STYLES } from "@/lib/endpoints";

const SAMPLE_KIND = {
  "tenant-detail": "tenant",
  "tenant-patch": "tenant",
  "project-detail": "project",
  "project-patch": "project",
  "project-delete": "project",
  "task-detail": "task",
  "task-patch": "task",
  "task-delete": "task",
  "comments-list": "task",
  "comments-create": "task",
  "member-patch": "member",
};

const GROUPS = ["Authentication", "Workspaces", "Members & roles", "Projects", "Tasks", "Insights", "Platform"];

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function Highlighted({ text }) {
  const nodes = [];
  const pattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\bnull\b/g;
  let lastIndex = 0;
  let match;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[1] && match[2]) {
      nodes.push(
        <span key={`k${key++}`} className="json-key">
          {match[1]}
        </span>,
      );
      nodes.push(match[2]);
    } else if (match[1]) {
      nodes.push(
        <span key={`s${key++}`} className="json-string">
          {match[1]}
        </span>,
      );
    } else if (match[3]) {
      nodes.push(
        <span key={`b${key++}`} className="json-bool">
          {match[0]}
        </span>,
      );
    } else if (match[0] === "null") {
      nodes.push(
        <span key={`n${key++}`} className="json-null">
          null
        </span>,
      );
    } else {
      nodes.push(
        <span key={`d${key++}`} className="json-number">
          {match[0]}
        </span>,
      );
    }
    lastIndex = pattern.lastIndex;
  }
  nodes.push(text.slice(lastIndex));
  return <pre className="mono whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-slate-200">{nodes}</pre>;
}

export default function ApiConsole() {
  const [token, setToken] = useState("");
  const [refresh, setRefresh] = useState("");
  const [me, setMe] = useState(null);
  const [activeSlug, setActiveSlug] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState(null);
  const [credentials, setCredentials] = useState({ email: DEMO_ACCOUNTS[0].email, password: DEMO_PASSWORD });

  const [selectedId, setSelectedId] = useState("tasks-list");
  const [pathValues, setPathValues] = useState({});
  const [queryValues, setQueryValues] = useState({});
  const [bodyText, setBodyText] = useState("");
  const [samples, setSamples] = useState({});
  const [response, setResponse] = useState(null);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isolation, setIsolation] = useState(null);
  const bootedRef = useRef(false);

  const endpoint = useMemo(
    () => ENDPOINTS.find((item) => item.id === selectedId) ?? ENDPOINTS[0],
    [selectedId],
  );

  const fillFromEndpoint = useCallback((nextEndpoint, sampleMap) => {
    const nextPath = {};
    for (const key of nextEndpoint.pathParams ?? []) {
      const kind = SAMPLE_KIND[nextEndpoint.id];
      nextPath[key] = (kind && sampleMap?.[kind]) || "";
    }
    setPathValues(nextPath);

    const nextQuery = {};
    for (const entry of nextEndpoint.query ?? []) {
      const [name, value = ""] = entry.split("=");
      nextQuery[name] = value;
    }
    setQueryValues(nextQuery);

    if (nextEndpoint.body === null || nextEndpoint.body === undefined) {
      setBodyText("");
    } else {
      const body = { ...nextEndpoint.body };
      if (typeof body.project === "string" && body.project.startsWith("<") && sampleMap?.project) {
        body.project = sampleMap.project;
      }
      if (typeof body.refresh === "string" && body.refresh.startsWith("<")) {
        // leave the placeholder so the user pastes their own refresh token
      }
      setBodyText(body.refresh && body.refresh.startsWith("<") ? pretty(body) : pretty(body));
    }
  }, []);

  const authorizedFetch = useCallback(
    async (path, { method = "GET", body, slug, signal } = {}) => {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const tenantSlug = slug ?? activeSlug;
      if (tenantSlug) headers["X-Tenant-Slug"] = tenantSlug;
      const started = performance.now();
      const res = await fetch(path, {
        method,
        headers,
        signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, ms: Math.round(performance.now() - started), text, path };
    },
    [token, activeSlug],
  );

  const loadMe = useCallback(
    async (accessToken) => {
      const headers = { "Content-Type": "application/json" };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      const res = await fetch("/api/auth/me/", { headers });
      if (!res.ok) return null;
      const data = await res.json();
      setMe(data);
      const preferred =
        data.workspaces?.find((w) => w.slug === "northwind-labs") ?? data.workspaces?.[0] ?? null;
      if (preferred) setActiveSlug(preferred.slug);
      return data;
    },
    [],
  );

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      try {
        await fetch("/api/seed/", { method: "POST" });
      } catch {
        /* ignore */
      }
      const stored = window.localStorage.getItem("orbit.access");
      if (stored) {
        setToken(stored);
        setRefresh(window.localStorage.getItem("orbit.refresh") ?? "");
        const data = await loadMe(stored);
        if (!data) {
          window.localStorage.removeItem("orbit.access");
          window.localStorage.removeItem("orbit.refresh");
          setToken("");
        }
      }
      fillFromEndpoint(ENDPOINTS.find((e) => e.id === "tasks-list"), null);
    })();
  }, [loadMe, fillFromEndpoint]);

  const signIn = useCallback(
    async (email, password) => {
      setAuthBusy(true);
      setAuthMessage(null);
      try {
        const started = performance.now();
        const res = await fetch("/api/auth/token/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const text = await res.text();
        const ms = Math.round(performance.now() - started);
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          /* ignore */
        }
        if (!res.ok) {
          setAuthMessage({ ok: false, ms, text });
          return;
        }
        setToken(data.access);
        setRefresh(data.refresh);
        window.localStorage.setItem("orbit.access", data.access);
        window.localStorage.setItem("orbit.refresh", data.refresh);
        const profile = await loadMe(data.access);
        setAuthMessage({
          ok: true,
          ms,
          text: pretty({
            detail: "Authentication successful.",
            user: profile?.email ?? data.user?.email,
            workspaces: profile?.workspaces?.map((w) => `${w.slug} (${w.role})`) ?? [],
          }),
        });
      } catch (error) {
        setAuthMessage({ ok: false, text: String(error) });
      } finally {
        setAuthBusy(false);
      }
    },
    [loadMe],
  );

  const signOut = useCallback(() => {
    setToken("");
    setRefresh("");
    setMe(null);
    setAuthMessage(null);
    window.localStorage.removeItem("orbit.access");
    window.localStorage.removeItem("orbit.refresh");
  }, []);

  const selectEndpoint = useCallback(
    (id) => {
      setSelectedId(id);
      setResponse(null);
      setIsolation(null);
      fillFromEndpoint(ENDPOINTS.find((e) => e.id === id), samples);
    },
    [fillFromEndpoint, samples],
  );

  const captureSample = useCallback((id, data) => {
    if (!data || typeof data !== "object") return;
    const first = Array.isArray(data.results) ? data.results[0] : data;
    if (!first?.id) return;
    setSamples((prev) => {
      const next = { ...prev };
      if (id.startsWith("projects")) next.project = first.id;
      else if (id.startsWith("tasks")) {
        next.task = first.id;
        if (first.project?.id) next.project = first.project.id;
      } else if (id.startsWith("members")) next.member = first.id;
      else if (id.startsWith("tenants")) next.tenant = first.id;
      return next;
    });
  }, []);

  const send = useCallback(async () => {
    setSending(true);
    setIsolation(null);
    let path = endpoint.path;
    for (const [key, value] of Object.entries(pathValues)) {
      path = path.replace(`{${key}}`, encodeURIComponent(value || ""));
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryValues)) {
      if (value !== "" && value !== undefined && value !== null) params.set(key, value);
    }
    const qs = params.toString();
    if (qs) path = `${path}?${qs}`;

    let payload;
    if (["POST", "PATCH", "PUT"].includes(endpoint.method) && bodyText.trim()) {
      try {
        payload = JSON.parse(bodyText);
      } catch (error) {
        setResponse({ status: 0, ok: false, ms: 0, text: `Invalid JSON in request body: ${error.message}`, path });
        setSending(false);
        return;
      }
    }

    try {
      const result = await authorizedFetch(path, { method: endpoint.method, body: payload });
      let parsed = result.text;
      try {
        parsed = pretty(JSON.parse(result.text));
      } catch {
        /* keep raw text */
      }
      setResponse({ ...result, text: parsed });
      try {
        captureSample(endpoint.id, JSON.parse(result.text));
      } catch {
        /* ignore */
      }
      if (result.status === 401 && token) setAuthMessage({ ok: false, ms: result.ms, text: result.text });
    } catch (error) {
      setResponse({ status: 0, ok: false, ms: 0, text: String(error), path });
    } finally {
      setSending(false);
    }
  }, [authorizedFetch, bodyText, captureSample, endpoint, pathValues, queryValues, token]);

  const runIsolationCheck = useCallback(async () => {
    setSending(true);
    try {
      const workspaces = me?.workspaces ?? [];
      const targets = workspaces.length ? workspaces : [];
      const runs = [];
      for (const workspace of targets) {
        const [projects, tasks] = await Promise.all([
          authorizedFetch("/api/projects/", { slug: workspace.slug }),
          authorizedFetch("/api/tasks/", { slug: workspace.slug }),
        ]);
        let projectData = {};
        let taskData = {};
        try {
          projectData = JSON.parse(projects.text);
          taskData = JSON.parse(tasks.text);
        } catch {
          /* ignore */
        }
        runs.push({
          slug: workspace.slug,
          role: workspace.role,
          plan: workspace.plan,
          projects: projectData.count ?? 0,
          tasks: taskData.count ?? 0,
          status: projects.status,
        });
      }
      setIsolation(runs);
    } finally {
      setSending(false);
    }
  }, [authorizedFetch, me]);

  const curl = useMemo(() => {
    let path = endpoint.path;
    for (const [key, value] of Object.entries(pathValues)) path = path.replace(`{${key}}`, value || key.toUpperCase());
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryValues)) if (value) params.set(key, value);
    const qs = params.toString();
    if (qs) path += `?${qs}`;
    const lines = [`curl -X ${endpoint.method} "${path.replace(/\/+(\?.*)?$/, "$1")}"`];
    if (endpoint.auth) lines.push(`  -H "Authorization: Bearer $ACCESS"`);
    if (Object.keys(pathValues).length || endpoint.auth) lines.push(`  -H "X-Tenant-Slug: ${activeSlug || "northwind-labs"}"`);
    if (["POST", "PATCH", "PUT"].includes(endpoint.method) && bodyText.trim()) {
      lines.push(`  -H "Content-Type: application/json"`);
      lines.push(`  -d '${bodyText.replace(/\n\s*/g, " ")}'`);
    }
    return lines.join(" \\\n");
  }, [activeSlug, bodyText, endpoint, pathValues, queryValues]);

  const copyCurl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }, [curl]);

  const grouped = useMemo(() => {
    return GROUPS.map((group) => ({ group, items: ENDPOINTS.filter((item) => item.group === group) })).filter(
      (bucket) => bucket.items.length,
    );
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      {/* Auth + endpoint list */}
      <div className="space-y-4">
        <section className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold tracking-wide text-slate-200">1 · Authenticate</h3>
            {token ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/30">
                token active
              </span>
            ) : (
              <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] text-slate-400 ring-1 ring-slate-500/30">
                anonymous
              </span>
            )}
          </div>

          <div className="mt-3 space-y-2">
            <input
              className="mono w-full rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-2 text-xs text-slate-200"
              value={credentials.email}
              onChange={(event) => setCredentials((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="email"
            />
            <input
              className="mono w-full rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-2 text-xs text-slate-200"
              value={credentials.password}
              onChange={(event) => setCredentials((prev) => ({ ...prev, password: event.target.value }))}
              placeholder="password"
              type="text"
            />
            <div className="flex gap-2">
              <button
                onClick={() => signIn(credentials.email, credentials.password)}
                disabled={authBusy}
                className="flex-1 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
              >
                {authBusy ? "Signing in…" : "POST /api/auth/token/"}
              </button>
              {token ? (
                <button
                  onClick={signOut}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-rose-500/60 hover:text-rose-300"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-3 grid gap-1">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                onClick={() => {
                  setCredentials({ email: account.email, password: DEMO_PASSWORD });
                  signIn(account.email, DEMO_PASSWORD);
                }}
                className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-950/40 px-2.5 py-1.5 text-left text-[11px] transition hover:border-indigo-500/50"
              >
                <span className="mono text-slate-300">{account.email}</span>
                <span className={`font-medium ${account.tone}`}>{account.role.split(" · ")[0]}</span>
              </button>
            ))}
            <p className="mono mt-1 text-[10.5px] text-slate-500">password for all demo users: {DEMO_PASSWORD}</p>
          </div>

          {authMessage ? (
            <div
              className={`mt-3 rounded-lg border p-2.5 text-[11px] ${
                authMessage.ok
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
                  : "border-rose-500/30 bg-rose-500/5 text-rose-200"
              }`}
            >
              <div className="mb-1 flex items-center justify-between font-semibold">
                <span>{authMessage.ok ? "200 OK" : "Error response"}</span>
                {authMessage.ms ? <span className="mono">{authMessage.ms} ms</span> : null}
              </div>
              <pre className="mono max-h-28 overflow-auto whitespace-pre-wrap break-words text-[11px]">{authMessage.text}</pre>
            </div>
          ) : null}
        </section>

        {token && me?.workspaces?.length ? (
          <section className="card p-4">
            <h3 className="text-sm font-semibold tracking-wide text-slate-200">2 · Active workspace</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              Sent as the <span className="mono text-slate-300">X-Tenant-Slug</span> header on every request. Switching it
              swaps the entire dataset while the JWT stays the same.
            </p>
            <div className="mt-3 space-y-1.5">
              {me.workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => setActiveSlug(workspace.slug)}
                  className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-left text-[11px] transition ${
                    activeSlug === workspace.slug
                      ? "border-indigo-500/60 bg-indigo-500/10 text-indigo-100"
                      : "border-slate-800 bg-slate-950/40 text-slate-300 hover:border-slate-600"
                  }`}
                >
                  <span className="font-medium">{workspace.name}</span>
                  <span className="mono text-slate-400">
                    {workspace.plan} · {workspace.role}
                  </span>
                </button>
              ))}
            </div>
            <button
              onClick={runIsolationCheck}
              disabled={sending || me.workspaces.length < 1}
              className="mt-3 w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/20 disabled:opacity-40"
            >
              Prove tenant isolation
            </button>
            {isolation?.length ? (
              <div className="mt-2 space-y-1">
                {isolation.map((row) => (
                  <div
                    key={row.slug}
                    className="mono flex items-center justify-between rounded-md border border-slate-800 bg-slate-950/50 px-2 py-1 text-[10.5px] text-slate-300"
                  >
                    <span>{row.slug}</span>
                    <span className="text-slate-500">
                      {row.projects} projects · {row.tasks} tasks · {row.status}
                    </span>
                  </div>
                ))}
                <p className="text-[10.5px] text-slate-500">
                  Same JWT, different rows - scoping happens server side, never in the client.
                </p>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="card p-4">
          <h3 className="text-sm font-semibold tracking-wide text-slate-200">3 · Endpoints</h3>
          <div className="mt-3 max-h-[26rem] space-y-3 overflow-auto pr-1">
            {grouped.map((bucket) => (
              <div key={bucket.group}>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">{bucket.group}</p>
                <div className="space-y-1">
                  {bucket.items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => selectEndpoint(item.id)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition ${
                        selectedId === item.id
                          ? "border-indigo-500/60 bg-indigo-500/10"
                          : "border-transparent hover:border-slate-700 hover:bg-slate-900/60"
                      }`}
                    >
                      <span
                        className={`mono rounded px-1.5 py-0.5 text-[10px] font-bold ring-1 ${
                          METHOD_STYLES[item.method] ?? "bg-slate-500/15 text-slate-300 ring-slate-500/30"
                        }`}
                      >
                        {item.method}
                      </span>
                      <span className="mono truncate text-[11px] text-slate-300">{item.path}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Request builder */}
      <div className="space-y-4">
        <section className="card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`mono rounded px-2 py-0.5 text-[11px] font-bold ring-1 ${
                METHOD_STYLES[endpoint.method] ?? "bg-slate-500/15 text-slate-300 ring-slate-500/30"
              }`}
            >
              {endpoint.method}
            </span>
            <span className="mono text-sm text-slate-100">{endpoint.path}</span>
            <span className="ml-auto rounded-full border border-slate-700 px-2 py-0.5 text-[10.5px] text-slate-400">
              requires role: {endpoint.roles}
            </span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{endpoint.summary}</p>

          {endpoint.pathParams?.length ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {endpoint.pathParams.map((param) => (
                <label key={param} className="block">
                  <span className="mono text-[10.5px] uppercase tracking-wide text-slate-500">path · {param}</span>
                  <input
                    value={pathValues[param] ?? ""}
                    onChange={(event) => setPathValues((prev) => ({ ...prev, [param]: event.target.value }))}
                    placeholder={`paste a ${SAMPLE_KIND[endpoint.id] ?? "uuid"}`}
                    className="mono mt-1 w-full rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-2 text-xs text-slate-200"
                  />
                </label>
              ))}
            </div>
          ) : null}

          {endpoint.query?.length ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {Object.entries(queryValues).map(([name, value]) => (
                <label key={name} className="block">
                  <span className="mono text-[10.5px] uppercase tracking-wide text-slate-500">query · {name}</span>
                  <input
                    value={value}
                    onChange={(event) => setQueryValues((prev) => ({ ...prev, [name]: event.target.value }))}
                    className="mono mt-1 w-full rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-2 text-xs text-slate-200"
                  />
                </label>
              ))}
            </div>
          ) : null}

          {["POST", "PATCH", "PUT"].includes(endpoint.method) ? (
            <div className="mt-3">
              <span className="mono text-[10.5px] uppercase tracking-wide text-slate-500">request body (json)</span>
              <textarea
                value={bodyText}
                onChange={(event) => setBodyText(event.target.value)}
                rows={Math.min(Math.max(bodyText.split("\n").length + 1, 6), 18)}
                spellCheck={false}
                className="mono mt-1 w-full rounded-lg border border-slate-700/60 bg-slate-950/70 p-3 text-xs leading-relaxed text-slate-200"
              />
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={send}
              disabled={sending}
              className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send request"}
            </button>
            <button
              onClick={copyCurl}
              className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-indigo-500/60 hover:text-indigo-200"
            >
              {copied ? "Copied cURL" : "Copy cURL"}
            </button>
            {endpoint.auth && !token ? (
              <span className="text-[11px] text-amber-300">
                This route needs a bearer token - sign in on the left first.
              </span>
            ) : null}
          </div>

          <pre className="mono mt-3 overflow-auto rounded-lg border border-slate-800 bg-black/40 p-3 text-[11px] leading-relaxed text-slate-400">
            {curl}
          </pre>
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-200">Response</h3>
            {response ? (
              <>
                <span
                  className={`mono rounded px-2 py-0.5 text-[11px] font-bold ${
                    response.ok
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-rose-500/15 text-rose-300"
                  }`}
                >
                  {response.status || "ERR"}
                </span>
                <span className="mono text-[11px] text-slate-500">{response.ms} ms</span>
                <span className="mono truncate text-[11px] text-slate-500">{response.path}</span>
              </>
            ) : (
              <span className="text-[11px] text-slate-500">Send a request to see the live payload.</span>
            )}
          </div>
          <div className="max-h-[30rem] overflow-auto p-5">
            {response ? (
              <Highlighted text={response.text || "(empty response body)"} />
            ) : (
              <p className="mono text-xs text-slate-600">
                // example: pick “GET /api/tasks/”, sign in as ada@orbit.dev and hit Send
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
