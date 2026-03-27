import { handleRoute } from "@/server/api/handleRoute";
import { parseCreateWorkspaceBody } from "@/server/api/settings";
import { parseJsonBody } from "@/server/api/validation";
import { createWorkspaceForCurrentUserWithTimezone } from "@/server/workspaces";
import { extractUserId } from "@/server/userId";
import { z } from "zod";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/workspaces", method: "POST", internalErrorMessage: "Failed to create workspace" },
    async (): Promise<Response> => {
      const body = parseCreateWorkspaceBody(await parseJsonBody(request, z.unknown()));
      const userId = extractUserId(request);
      const workspace = await createWorkspaceForCurrentUserWithTimezone(userId, userId, body.name, body.timezone);
      return Response.json({ workspaceId: workspace.workspaceId, name: workspace.name });
    },
  );
