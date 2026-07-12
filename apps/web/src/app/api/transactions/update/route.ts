import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseTransactionsUpdateBody } from "@/server/api/transactions";
import { parseJsonBody } from "@/server/api/validation";
import { getDemoAmountReport } from "@/server/demo/transactions";
import { updateLedgerEntry } from "@/server/transactions/updateLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/transactions/update", method: "POST", internalErrorMessage: "Database update failed" },
    async (): Promise<Response> => {
      const body = parseTransactionsUpdateBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        if (body.eventId !== undefined) {
          return Response.json({
            entryId: body.entryId,
            eventId: body.eventId,
            ts: new Date(body.ts).toISOString(),
            accountId: body.accountId,
            amount: body.amount,
            amountReport: getDemoAmountReport(body.amount, body.currency),
            currency: body.currency,
            kind: body.kind,
            category: body.category,
            counterparty: body.counterparty,
            note: body.note,
          });
        }
        return Response.json({ ok: true });
      }

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const entry = await updateLedgerEntry(userId, workspaceId, body);
      return Response.json(entry);
    },
  );
