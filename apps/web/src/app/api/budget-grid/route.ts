import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetGridQuery } from "@/server/api/budget";
import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
import { getDemoBudgetGrid } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-grid", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      const query = parseBudgetGridQuery(new URL(request.url).searchParams);

      if (isDemoModeFromRequest(request)) {
        return jsonNoStore(getDemoBudgetGrid(query.monthFrom, query.monthTo, query.planFrom, query.actualTo));
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const grid = await getBudgetGrid(userId, workspaceId, query.monthFrom, query.monthTo, query.planFrom, query.actualTo);
      return jsonNoStore(grid);
    },
  );
