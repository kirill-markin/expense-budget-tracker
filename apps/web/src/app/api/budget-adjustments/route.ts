import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetAdjustmentCreateBody } from "@/server/api/budget";
import { ApiRouteError } from "@/server/api/errors";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { BudgetAdjustmentConflictError, createBudgetAdjustment } from "@/server/budget/budgetAdjustments";
import { createDemoBudgetAdjustment, readDemoBudgetAdjustmentSession, serializeDemoBudgetAdjustmentSessionCookie } from "@/server/demo/budgetAdjustments";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-adjustments", method: "POST", internalErrorMessage: "Budget adjustment create failed" },
    async (): Promise<Response> => {
      const body = parseBudgetAdjustmentCreateBody(await parseJsonBody(request, z.unknown()));

      try {
        if (isDemoModeFromRequest(request)) {
          const created = createDemoBudgetAdjustment(
            readDemoBudgetAdjustmentSession(request),
            body,
          );
          const response = Response.json(created.adjustment);
          response.headers.set(
            "Set-Cookie",
            serializeDemoBudgetAdjustmentSessionCookie(created.state),
          );
          return response;
        }

        const userId = extractUserId(request);
        const workspaceId = extractWorkspaceId(request);
        return Response.json(await createBudgetAdjustment(userId, workspaceId, body));
      } catch (error) {
        if (error instanceof BudgetAdjustmentConflictError) {
          throw new ApiRouteError(409, error.message);
        }
        throw error;
      }
    },
  );
