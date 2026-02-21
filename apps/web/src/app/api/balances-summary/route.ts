import { getBalancesSummary } from "@/server/balances/getBalancesSummary";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);
  const summary = await getBalancesSummary(userId, workspaceId);
  return Response.json(summary);
};
