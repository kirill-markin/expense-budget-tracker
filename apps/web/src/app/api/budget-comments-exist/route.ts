import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import { parseBudgetMonthRangeQuery } from "@/server/api/budget";
import { getCommentedCells } from "@/server/budget/getCommentedCells";
import { getDemoCommentedCells } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-comments-exist", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      const query = parseBudgetMonthRangeQuery(new URL(request.url).searchParams);

      if (isDemoModeFromRequest(request)) {
        return jsonNoStore({ cells: getDemoCommentedCells(query) });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const cells = await getCommentedCells(userId, workspaceId, query);
      return jsonNoStore({ cells });
    },
  );
