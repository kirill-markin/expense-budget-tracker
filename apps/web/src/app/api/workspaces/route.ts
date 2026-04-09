import { handleRoute } from "@/server/api/handleRoute";
import { jsonNoStore } from "@/server/api/noStore";
import { parseCreateWorkspaceBody } from "@/server/api/settings";
import { parseJsonBody } from "@/server/api/validation";
import { createWorkspaceForCurrentUserWithTimezone, listWorkspaces } from "@/server/workspaces";
import { extractUserId, extractWorkspaceId } from "@/server/userId";
import { z } from "zod";

export const dynamic = "force-dynamic";

export const GET = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/workspaces", method: "GET", internalErrorMessage: "Failed to list workspaces" },
    async (): Promise<Response> => {
      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const workspaces = await listWorkspaces(userId, workspaceId);
      return jsonNoStore(workspaces);
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/workspaces", method: "POST", internalErrorMessage: "Failed to create workspace" },
    async (): Promise<Response> => {
      const body = parseCreateWorkspaceBody(await parseJsonBody(request, z.unknown()));
      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const workspace = await createWorkspaceForCurrentUserWithTimezone(userId, workspaceId, body.name, body.timezone);
      return Response.json({ workspaceId: workspace.workspaceId, name: workspace.name });
    },
  );
