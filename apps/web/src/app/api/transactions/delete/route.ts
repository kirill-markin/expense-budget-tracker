import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseTransactionsDeleteBody } from "@/server/api/transactions";
import { parseJsonBody } from "@/server/api/validation";
import { deleteLedgerEntry } from "@/server/transactions/deleteLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/transactions/delete", method: "POST", internalErrorMessage: "Database delete failed" },
    async (): Promise<Response> => {
      const body = parseTransactionsDeleteBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        return Response.json({ ok: true });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      await deleteLedgerEntry(userId, workspaceId, body.entryId);
      return Response.json({ ok: true });
    },
  );
