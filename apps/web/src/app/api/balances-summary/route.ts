import { getBalancesSummary } from "@/server/balances/getBalancesSummary";
import { extractUserId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const summary = await getBalancesSummary(userId);
  return Response.json(summary);
};
