import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetPlanBody } from "@/server/api/budget";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { insertBudgetPlan } from "@/server/budget/insertBudgetPlan";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-plan", method: "POST", internalErrorMessage: "Database insert failed" },
    async (): Promise<Response> => {
      const body = parseBudgetPlanBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        return Response.json({ ok: true });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);

      await insertBudgetPlan(userId, workspaceId, body);

      return Response.json({ ok: true });
    },
  );
