import crypto from "node:crypto";

/**
 * Minimal HS256 JWT implementation (same wire format as
 * djangorestframework-simplejwt) so the preview mirror and the Django
 * backend issue interchangeable looking tokens.
 */
const SECRET = process.env.JWT_SECRET ?? "insecure-dev-secret-change-me";
const JWT_ISSUER = "orbit.api";

export const ACCESS_TOKEN_TTL = 60 * 60; // seconds
export const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 7; // seconds

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

function hmac(data) {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

function signToken(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + ttlSeconds,
    iss: JWT_ISSUER,
  };
  const head = encode({ alg: "HS256", typ: "JWT" });
  const claims = encode(body);
  return `${head}.${claims}.${hmac(`${head}.${claims}`)}`;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 32).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  const [algorithm, salt, digest] = String(stored ?? "").split(":");
  if (algorithm !== "scrypt" || !salt || !digest) return false;
  const candidate = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(digest, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export function createAccessToken(user, membership) {
  return signToken(
    {
      token_type: "access",
      sub: user.id,
      email: user.email,
      full_name: user.fullName,
      tenant_id: membership?.tenantId ?? null,
      tenant_slug: membership?.tenantSlug ?? null,
      role: membership?.role ?? null,
    },
    ACCESS_TOKEN_TTL,
  );
}

export function createRefreshToken(user, membership) {
  return signToken(
    {
      token_type: "refresh",
      sub: user.id,
      tenant_id: membership?.tenantId ?? null,
    },
    REFRESH_TOKEN_TTL,
  );
}

export class TokenError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
    this.detail = detail;
  }
}

export function verifyToken(token, expectedType = "access") {
  if (!token) throw new TokenError("token_not_valid", "Authentication credentials were not provided.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("token_not_valid", "Token is malformed.");

  const [head, claims, signature] = parts;
  const expectedSignature = hmac(`${head}.${claims}`);
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expectedSignature);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw new TokenError("token_not_valid", "Token signature verification failed.");
  }

  let payload;
  try {
    payload = decode(claims);
  } catch {
    throw new TokenError("token_not_valid", "Token payload could not be decoded.");
  }

  if (payload.iss !== JWT_ISSUER) {
    throw new TokenError("token_not_valid", "Token issuer is not recognised.");
  }
  if (payload.token_type !== expectedType) {
    throw new TokenError("token_not_valid", "Token has wrong type.");
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
    throw new TokenError("token_not_valid", "Token is expired.");
  }
  return payload;
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
}
