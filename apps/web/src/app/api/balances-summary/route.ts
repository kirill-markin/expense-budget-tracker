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
  const summary = await getBalancesSummary(userId, workspaceId);
  return Response.json(summary);
};
