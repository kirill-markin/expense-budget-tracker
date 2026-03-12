import { randomUUID } from "crypto";

import { z } from "zod";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { handleRoute } from "@/server/api/handleRoute";
import { parseTransactionsCreateBody } from "@/server/api/transactions";
import { parseJsonBody } from "@/server/api/validation";
import { createLedgerEntry } from "@/server/transactions/createLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

const DEMO_FX_RATES: Readonly<Record<string, number>> = { USD: 1, EUR: 1.029, GBP: 1.24 };

const getDemoAmountUsd = (amount: number, currency: string): number | null => {
  if (currency.length === 0) return null;
  const rate = DEMO_FX_RATES[currency];
  if (rate === undefined) return null;
  return Math.round(amount * rate * 100) / 100;
};

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
          amountUsd: getDemoAmountUsd(body.amount, body.currency),
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
