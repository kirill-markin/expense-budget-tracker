import { z } from "zod";

import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { ApiRouteError, createBadRequestError } from "@/server/api/errors";
import { deleteWorkspaceChatFileObjects } from "@/server/chatFiles/cleanup";
import {
  deleteWorkspace,
  listWorkspaces,
  WorkspaceDeletionRequiresSingleMemberError,
} from "@/server/workspaces";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const bodySchema = z.object({
  confirmText: z.string().min(1),
});

type DeleteWorkspaceRouteDependencies = Readonly<{
  listWorkspaces: typeof listWorkspaces;
  deleteWorkspaceChatFileObjects: typeof deleteWorkspaceChatFileObjects;
  deleteWorkspace: typeof deleteWorkspace;
}>;

const DEFAULT_DELETE_WORKSPACE_ROUTE_DEPENDENCIES: DeleteWorkspaceRouteDependencies = {
  listWorkspaces,
  deleteWorkspaceChatFileObjects,
  deleteWorkspace,
};

export const postDeleteWorkspaceRouteWithDeps = async (
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
  dependencies: DeleteWorkspaceRouteDependencies,
): Promise<Response> =>
  handleRoute(
    { route: "/api/workspaces/[workspaceId]/delete", method: "POST", internalErrorMessage: "Workspace deletion failed" },
    async (): Promise<Response> => {
      const { workspaceId: targetWorkspaceId } = await params;
      const body = await parseJsonBody(request, bodySchema);
      const userId = extractUserId(request);
      const currentWorkspaceId = extractWorkspaceId(request);

      const workspaces = await dependencies.listWorkspaces(userId, currentWorkspaceId);
      const target = workspaces.find((w) => w.workspaceId === targetWorkspaceId);

      if (target === undefined) {
        throw createBadRequestError("Workspace not found");
      }

      if (body.confirmText !== target.name) {
        throw createBadRequestError("Confirmation text does not match workspace name");
      }

      try {
        // Stored objects first: the database deletion cascades their rows and
        // cannot reach object storage. The cleanup rejects a workspace the
        // deletion would refuse, so it raises before removing any object.
        await dependencies.deleteWorkspaceChatFileObjects(userId, currentWorkspaceId, targetWorkspaceId);
        await dependencies.deleteWorkspace(userId, currentWorkspaceId, targetWorkspaceId);
      } catch (error) {
        if (error instanceof WorkspaceDeletionRequiresSingleMemberError) {
          throw new ApiRouteError(403, error.message);
        }
        throw error;
      }
      return Response.json({ ok: true });
    },
  );

export const POST = async (
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> =>
  postDeleteWorkspaceRouteWithDeps(request, context, DEFAULT_DELETE_WORKSPACE_ROUTE_DEPENDENCIES);
