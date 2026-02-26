import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getBalancesSummary } from "@/server/balances/getBalancesSummary";
import { getDemoBalancesSummary } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return Response.json(getDemoBalancesSummary());
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const summary = await getBalancesSummary(userId, workspaceId);
    return Response.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("balances-summary GET: %s", message);
    return new Response("Database query failed", { status: 500 });
  }
};
