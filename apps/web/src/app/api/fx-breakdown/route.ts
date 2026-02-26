import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getFxBreakdown } from "@/server/budget/getFxBreakdown";
import { getDemoFxBreakdown } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const month = url.searchParams.get("month");

  if (month === null) {
    return new Response("Missing required query param: month", { status: 400 });
  }

  if (!MONTH_PATTERN.test(month)) {
    return new Response("Invalid month format. Expected YYYY-MM", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    return Response.json(getDemoFxBreakdown(month));
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const result = await getFxBreakdown(userId, workspaceId, month);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("fx-breakdown GET: %s", message);
    return new Response("Database query failed", { status: 500 });
  }
};
