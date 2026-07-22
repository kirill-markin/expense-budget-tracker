import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetAdjustmentCreateBody } from "@/server/api/budget";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { createBudgetAdjustment } from "@/server/budget/budgetAdjustments";
import { createDemoBudgetAdjustment } from "@/server/demo/budgetAdjustments";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-adjustments", method: "POST", internalErrorMessage: "Budget adjustment create failed" },
    async (): Promise<Response> => {
      const body = parseBudgetAdjustmentCreateBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        return Response.json(createDemoBudgetAdjustment(body));
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      return Response.json(await createBudgetAdjustment(userId, workspaceId, body));
    },
  );
