import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getCommentedCells } from "@/server/budget/getCommentedCells";
import { getDemoCommentedCells } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export const GET = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const monthFrom = url.searchParams.get("monthFrom");
  const monthTo = url.searchParams.get("monthTo");

  if (monthFrom === null || monthTo === null) {
    return new Response("Missing required query params: monthFrom, monthTo", { status: 400 });
  }

  if (!MONTH_PATTERN.test(monthFrom) || !MONTH_PATTERN.test(monthTo)) {
    return new Response("Invalid month format. Expected YYYY-MM", { status: 400 });
  }

  if (monthFrom > monthTo) {
    return new Response("monthFrom must be <= monthTo", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    return Response.json({ cells: getDemoCommentedCells({ monthFrom, monthTo }) });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const cells = await getCommentedCells(userId, workspaceId, { monthFrom, monthTo });
    return Response.json({ cells });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("budget-comments-exist GET: %s", message);
    return new Response("Database query failed", { status: 500 });
  }
};
