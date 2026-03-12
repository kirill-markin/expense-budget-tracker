import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetPlanFillBody } from "@/server/api/budget";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { fillBudgetBase } from "@/server/budget/fillBudgetBase";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-plan-fill", method: "POST", internalErrorMessage: "Database insert failed" },
    async (): Promise<Response> => {
      const body = parseBudgetPlanFillBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        const fromNum = Number(body.fromMonth.slice(5));
        const monthsFilled = 12 - fromNum;
        return Response.json({ ok: true, monthsFilled });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const filled = await fillBudgetBase(userId, workspaceId, body);
      return Response.json({ ok: true, monthsFilled: filled });
    },
  );
