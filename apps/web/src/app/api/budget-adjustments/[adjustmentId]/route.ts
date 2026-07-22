import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetAdjustmentId, parseBudgetAdjustmentPatchBody } from "@/server/api/budget";
import { ApiRouteError } from "@/server/api/errors";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { BudgetAdjustmentNotFoundError, deleteBudgetAdjustment, patchBudgetAdjustment } from "@/server/budget/budgetAdjustments";
import { deleteDemoBudgetAdjustment, patchDemoBudgetAdjustment, readDemoBudgetAdjustmentSession, serializeDemoBudgetAdjustmentSessionCookie } from "@/server/demo/budgetAdjustments";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RouteContext = Readonly<{
  params: Promise<{
    adjustmentId: string;
  }>;
}>;

const toNotFoundRouteError = (error: unknown): never => {
  if (error instanceof BudgetAdjustmentNotFoundError) {
    throw new ApiRouteError(404, error.message);
  }
  throw error;
};

export const PATCH = async (request: Request, context: RouteContext): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-adjustments/[adjustmentId]", method: "PATCH", internalErrorMessage: "Budget adjustment update failed" },
    async (): Promise<Response> => {
      const { adjustmentId: rawAdjustmentId } = await context.params;
      const adjustmentId = parseBudgetAdjustmentId(rawAdjustmentId);
      const body = parseBudgetAdjustmentPatchBody(await parseJsonBody(request, z.unknown()));

      try {
        if (isDemoModeFromRequest(request)) {
          const patched = patchDemoBudgetAdjustment(
            readDemoBudgetAdjustmentSession(request),
            adjustmentId,
            body,
            new Date().toISOString(),
          );
          const response = Response.json(patched.adjustment);
          response.headers.set(
            "Set-Cookie",
            serializeDemoBudgetAdjustmentSessionCookie(patched.state),
          );
          return response;
        }

        const userId = extractUserId(request);
        const workspaceId = extractWorkspaceId(request);
        return Response.json(await patchBudgetAdjustment(userId, workspaceId, adjustmentId, body));
      } catch (error) {
        return toNotFoundRouteError(error);
      }
    },
  );

export const DELETE = async (request: Request, context: RouteContext): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-adjustments/[adjustmentId]", method: "DELETE", internalErrorMessage: "Budget adjustment delete failed" },
    async (): Promise<Response> => {
      const { adjustmentId: rawAdjustmentId } = await context.params;
      const adjustmentId = parseBudgetAdjustmentId(rawAdjustmentId);

      try {
        if (isDemoModeFromRequest(request)) {
          const state = deleteDemoBudgetAdjustment(
            readDemoBudgetAdjustmentSession(request),
            adjustmentId,
          );
          const response = Response.json({ ok: true });
          response.headers.set(
            "Set-Cookie",
            serializeDemoBudgetAdjustmentSessionCookie(state),
          );
          return response;
        }

        const userId = extractUserId(request);
        const workspaceId = extractWorkspaceId(request);
        await deleteBudgetAdjustment(userId, workspaceId, adjustmentId);
        return Response.json({ ok: true });
      } catch (error) {
        return toNotFoundRouteError(error);
      }
    },
  );
