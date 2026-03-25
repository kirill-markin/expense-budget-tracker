import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import { getBalancesSummary } from "@/server/balances/getBalancesSummary";
import { getDemoBalancesSummary } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/balances-summary", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      if (isDemoModeFromRequest(request)) {
        return jsonNoStore(getDemoBalancesSummary());
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const summary = await getBalancesSummary(userId, workspaceId);
      return jsonNoStore(summary);
    },
  );
