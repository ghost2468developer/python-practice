import { NextResponse } from "next/server";

/** DRF-flavoured API exception. */
export class ApiError extends Error {
  constructor(status, payload, code) {
    super(typeof payload === "string" ? payload : "Request failed.");
    this.status = status;
    this.payload = payload;
    this.code = code ?? null;
  }
}

export const badRequest = (detail, code) => new ApiError(400, { detail, code });
export const unauthorized = (detail = "Authentication credentials were not provided.") =>
  new ApiError(401, { detail, code: "not_authenticated" });
export const permissionDenied = (detail = "You do not have permission to perform this action.") =>
  new ApiError(403, { detail, code: "permission_denied" });
export const notFound = (detail = "Not found.") => new ApiError(404, { detail, code: "not_found" });
export const conflict = (detail) => new ApiError(409, { detail, code: "conflict" });
export const validationError = (fields) => new ApiError(400, fields, "invalid");

export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export function ok(data, meta) {
  return json(meta ? { ...data, ...meta } : data);
}

/**
 * Wraps a handler so thrown `ApiError`s (and unexpected failures) come back as
 * DRF-style JSON instead of a Next.js 500 page.
 */
export function route(handler) {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      return fail(error);
    }
  };
}

/** Mirrors DRF's default validation error body. */
export function fail(error) {
  if (error instanceof ApiError) {
    return json(error.payload, { status: error.status });
  }
  if (error?.code === "23505") {
    return json({ detail: "Value already exists.", code: "unique" }, { status: 409 });
  }
  if (error?.code === "23503") {
    return json({ detail: "Related object does not exist.", code: "invalid" }, { status: 400 });
  }
  console.error("[api] unhandled error", error);
  return json({ detail: "Internal server error." }, { status: 500 });
}

export const parseLimitOffset = (request, defaultLimit = 20, maxLimit = 100) => {
  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit") ?? defaultLimit);
  const offsetParam = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), maxLimit) : defaultLimit;
  const offset = Number.isFinite(offsetParam) ? Math.max(Math.trunc(offsetParam), 0) : 0;
  return { limit, offset };
};

/** LimitOffsetPagination shape from DRF. */
export function paginate(rows, total, { limit, offset }, basePath) {
  const url = new URL(basePath ?? "http://local/api", "http://local");
  const build = (nextOffset) => {
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(nextOffset));
    return url.toString().replace("http://local", "");
  };
  return {
    count: total,
    next: offset + limit < total ? build(offset + limit) : null,
    previous: offset > 0 ? build(Math.max(offset - limit, 0)) : null,
    results: rows,
  };
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw validationError({ non_field_errors: ["Expected a JSON object."] });
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw validationError({ non_field_errors: ["Invalid JSON body."] });
  }
}

export function requireFields(body, definitions) {
  const errors = {};
  const clean = {};
  for (const [field, rule] of Object.entries(definitions)) {
    const raw = body[field];
    const value = typeof raw === "string" ? raw.trim() : raw;
    const missing = value === undefined || value === null || value === "";
    if (missing) {
      if (rule.required) errors[field] = ["This field is required."];
      else clean[field] = rule.default ?? null;
      continue;
    }
    if (rule.type === "string" && typeof value !== "string") {
      errors[field] = ["A valid string is required."];
      continue;
    }
    if (rule.type === "string" && rule.maxLength && value.length > rule.maxLength) {
      errors[field] = [`Ensure this field has no more than ${rule.maxLength} characters.`];
      continue;
    }
    if (rule.type === "number") {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        errors[field] = ["A valid number is required."];
        continue;
      }
      clean[field] = num;
      continue;
    }
    if (rule.choices && !rule.choices.includes(value)) {
      errors[field] = [`"${value}" is not a valid choice.`];
      continue;
    }
    clean[field] = value;
  }
  if (Object.keys(errors).length) throw validationError(errors);
  return clean;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value, field = "id") {
  if (!UUID_RE.test(String(value ?? ""))) {
    throw validationError({ [field]: ["Must be a valid UUID."] });
  }
  return value;
}
