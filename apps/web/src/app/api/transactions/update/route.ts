import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseTransactionsUpdateBody } from "@/server/api/transactions";
import { parseJsonBody } from "@/server/api/validation";
import { updateLedgerEntry } from "@/server/transactions/updateLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/transactions/update", method: "POST", internalErrorMessage: "Database update failed" },
    async (): Promise<Response> => {
      const body = parseTransactionsUpdateBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        return Response.json({ ok: true });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      await updateLedgerEntry(userId, workspaceId, body);
      return Response.json({ ok: true });
    },
  );
