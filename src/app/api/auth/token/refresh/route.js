import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createAccessToken, createRefreshToken, verifyToken, TokenError } from "@/lib/auth";
import { json, readJson, unauthorized, validationError , route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/auth/token/refresh/ — SimpleJWT compatible refresh endpoint. */
export const POST = route(async function POST(request) {
  const body = await readJson(request);
  const refresh = typeof body.refresh === "string" ? body.refresh.trim() : "";
  if (!refresh) throw validationError({ refresh: ["This field is required."] });

  let claims;
  try {
    claims = verifyToken(refresh, "refresh");
  } catch (error) {
    if (error instanceof TokenError) throw unauthorized(error.detail);
    throw error;
  }

  const [user] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!user || !user.isActive) throw unauthorized("User account is disabled.");

  const membership = claims.tenant_id ? { tenantId: claims.tenant_id } : null;
  return json({
    access: createAccessToken(user, membership),
    refresh: createRefreshToken(user, membership),
  });
});
