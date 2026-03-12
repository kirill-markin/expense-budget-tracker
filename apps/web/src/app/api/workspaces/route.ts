import { z } from "zod";

import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { createWorkspaceForCurrentUser } from "@/server/workspaces";
import { extractUserId } from "@/server/userId";

const createWorkspaceBodySchema = z.object({
  name: z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: "name is required and must be a non-empty string" });
      return;
    }
    if (value.trim().length > 100) {
      ctx.addIssue({ code: "custom", message: "name must be 100 characters or fewer" });
    }
  }).transform((value): string => (value as string).trim()),
});

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/workspaces", method: "POST", internalErrorMessage: "Failed to create workspace" },
    async (): Promise<Response> => {
      const body = await parseJsonBody(request, createWorkspaceBodySchema);
      const userId = extractUserId(request);
      const workspace = await createWorkspaceForCurrentUser(userId, userId, body.name);
      return Response.json({ workspaceId: workspace.workspaceId, name: workspace.name });
    },
  );
