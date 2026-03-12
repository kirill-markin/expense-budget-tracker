import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetGridQuery } from "@/server/api/budget";
import { handleRoute } from "@/server/api/handleRoute";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
import { getDemoBudgetGrid } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-grid", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      const query = parseBudgetGridQuery(new URL(request.url).searchParams);

      if (isDemoModeFromRequest(request)) {
        return Response.json(getDemoBudgetGrid(query.monthFrom, query.monthTo, query.planFrom, query.actualTo));
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const grid = await getBudgetGrid(userId, workspaceId, query.monthFrom, query.monthTo, query.planFrom, query.actualTo);
      return Response.json(grid);
    },
  );
