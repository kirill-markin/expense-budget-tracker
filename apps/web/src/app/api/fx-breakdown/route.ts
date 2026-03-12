import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseFxBreakdownQuery } from "@/server/api/budget";
import { handleRoute } from "@/server/api/handleRoute";
import { getFxBreakdown } from "@/server/budget/getFxBreakdown";
import { getDemoFxBreakdown } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/fx-breakdown", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      const query = parseFxBreakdownQuery(new URL(request.url).searchParams);

      if (isDemoModeFromRequest(request)) {
        return Response.json(getDemoFxBreakdown(query.month));
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const result = await getFxBreakdown(userId, workspaceId, query.month);
      return Response.json(result);
    },
  );
