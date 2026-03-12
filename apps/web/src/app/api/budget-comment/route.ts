import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { parseBudgetCommentBody, parseBudgetCommentQuery } from "@/server/api/budget";
import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { getLatestComment } from "@/server/budget/getLatestComment";
import { insertBudgetComment } from "@/server/budget/insertBudgetComment";
import { getDemoLatestComment } from "@/server/demo/data";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-comment", method: "GET", internalErrorMessage: "Database query failed" },
    async (): Promise<Response> => {
      const query = parseBudgetCommentQuery(new URL(request.url).searchParams);

      if (isDemoModeFromRequest(request)) {
        return Response.json({ comment: getDemoLatestComment(query) });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const comment = await getLatestComment(userId, workspaceId, query);
      return Response.json({ comment });
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/budget-comment", method: "POST", internalErrorMessage: "Database insert failed" },
    async (): Promise<Response> => {
      const body = parseBudgetCommentBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        return Response.json({ ok: true });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      await insertBudgetComment(userId, workspaceId, body);
      return Response.json({ ok: true });
    },
  );
