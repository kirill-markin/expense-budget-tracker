import { verifyIapJwt } from "@/server/auth/verifyIapJwt";
import { getBalancesSummary } from "@/server/balances/getBalancesSummary";

export const GET = async (request: Request): Promise<Response> => {
  try {
    await verifyIapJwt(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Unauthorized: ${message}`, { status: 401 });
  }

  const summary = await getBalancesSummary();
  return Response.json(summary);
};
