import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseTransactionsFilterQuery } from "@/server/api/transactions";
import { getTransactionsPage } from "@/server/transactions/getTransactions";
import { getDemoTransactionsPage } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/transactions", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      const filter = parseTransactionsFilterQuery(new URL(request.url).searchParams);

      if (isDemoModeFromRequest(request)) {
        return Response.json(getDemoTransactionsPage(filter));
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const page = await getTransactionsPage(userId, workspaceId, filter);
      return Response.json(page);
    },
  );
