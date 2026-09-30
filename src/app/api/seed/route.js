import { json , route } from "@/lib/http";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

/** POST /api/seed/ — load the demo workspaces (no auth: preview convenience). */
export const POST = route(async function POST() {
  const result = await ensureSeed();
  return json({
    ...result,
    detail: result.created
      ? "Demo workspaces, projects, tasks and comments created."
      : "Demo data already present — nothing was changed.",
  });
});

export const GET = route(async function GET() {
  return json(await ensureSeed());
});
