import { z } from "zod";

import { handleRoute } from "@/server/api/handleRoute";
import { parseJsonBody } from "@/server/api/validation";
import { createBadRequestError } from "@/server/api/errors";
import { deleteWorkspace, listWorkspaces } from "@/server/workspaces";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const bodySchema = z.object({
  confirmText: z.string().min(1),
});

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
): Promise<Response> =>
  handleRoute(
    { route: "/api/workspaces/[workspaceId]/delete", method: "POST", internalErrorMessage: "Workspace deletion failed" },
    async (): Promise<Response> => {
      const { workspaceId: targetWorkspaceId } = await params;
      const body = await parseJsonBody(request, bodySchema);
      const userId = extractUserId(request);
      const currentWorkspaceId = extractWorkspaceId(request);

      const workspaces = await listWorkspaces(userId, currentWorkspaceId);
      const target = workspaces.find((w) => w.workspaceId === targetWorkspaceId);

      if (target === undefined) {
        throw createBadRequestError("Workspace not found");
      }

      if (body.confirmText !== target.name) {
        throw createBadRequestError("Confirmation text does not match workspace name");
      }

      await deleteWorkspace(userId, currentWorkspaceId, targetWorkspaceId);
      return Response.json({ ok: true });
    },
  );
