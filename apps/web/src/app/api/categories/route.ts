import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { getDemoCategories } from "@/server/demo/data";
import { getCategories } from "@/server/transactions/getTransactions";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/categories", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      if (isDemoModeFromRequest(request)) {
        return Response.json({ categories: getDemoCategories() });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const categories = await getCategories(userId, workspaceId);
      return Response.json({ categories });
    },
  );
