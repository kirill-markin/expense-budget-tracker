import { randomUUID } from "crypto";

import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseTransactionsCreateBody } from "@/server/api/transactions";
import { parseJsonBody } from "@/server/api/validation";
import { getDemoAmountReport } from "@/server/demo/transactions";
import { createLedgerEntry } from "@/server/transactions/createLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const POST = async (request: Request): Promise<Response> =>
  handleRoute(
    { route: "/api/transactions/create", method: "POST", internalErrorMessage: "Database create failed" },
    async (): Promise<Response> => {
      const body = parseTransactionsCreateBody(await parseJsonBody(request, z.unknown()));

      if (isDemoModeFromRequest(request)) {
        const eventId = randomUUID();
        return Response.json({
          entryId: randomUUID(),
          eventId,
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

      const userId = extractUserId(request);
      const workspaceId = extractWorkspaceId(request);
      const entry = await createLedgerEntry(userId, workspaceId, body);
      return Response.json(entry);
    },
  );
