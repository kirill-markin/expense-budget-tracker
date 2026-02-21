import { getBalancesSummary } from "@/server/balances/getBalancesSummary";

export const GET = async (): Promise<Response> => {
  const summary = await getBalancesSummary();
  return Response.json(summary);
};
