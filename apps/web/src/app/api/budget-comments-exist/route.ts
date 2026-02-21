import { getCommentedCells } from "@/server/budget/getCommentedCells";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export const GET = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
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

  try {
    const cells = await getCommentedCells(userId, workspaceId, { monthFrom, monthTo });
    return Response.json({ cells });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database query failed: ${message}`, { status: 500 });
  }
};
