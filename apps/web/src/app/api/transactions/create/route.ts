import { randomUUID } from "crypto";

import { isDemoModeFromRequest } from "@/lib/demoMode";
import { createLedgerEntry } from "@/server/transactions/createLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RequestBody = Readonly<{
  ts: unknown;
  accountId: unknown;
  amount: unknown;
  currency: unknown;
  kind: unknown;
  category: unknown;
  counterparty: unknown;
  note: unknown;
}>;

const VALID_KINDS: ReadonlyArray<string> = ["income", "spend", "transfer"];
const DEMO_FX_RATES: Readonly<Record<string, number>> = { USD: 1, EUR: 1.029, GBP: 1.24 };

const getDemoAmountUsd = (amount: number, currency: string): number | null => {
  if (currency.length === 0) return null;
  const rate = DEMO_FX_RATES[currency];
  if (rate === undefined) return null;
  return Math.round(amount * rate * 100) / 100;
};

export const POST = async (request: Request): Promise<Response> => {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { ts, accountId, amount, currency, kind, category, counterparty, note } = body;

  if (typeof ts !== "string" || isNaN(Date.parse(ts))) {
    return new Response("Invalid ts. Expected ISO 8601 date string", { status: 400 });
  }

  if (typeof accountId !== "string" || accountId.length > 200) {
    return new Response("Invalid accountId. Expected string (max 200 chars)", { status: 400 });
  }

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return new Response("Invalid amount. Expected finite number", { status: 400 });
  }

  if (typeof currency !== "string" || currency.length > 10) {
    return new Response("Invalid currency. Expected string (max 10 chars)", { status: 400 });
  }

  if (typeof kind !== "string" || !VALID_KINDS.includes(kind)) {
    return new Response("Invalid kind. Expected one of: income, spend, transfer", { status: 400 });
  }

  if (category !== null && (typeof category !== "string" || category.length > 200)) {
    return new Response("Invalid category. Expected string (max 200 chars) or null", { status: 400 });
  }

  if (counterparty !== null && (typeof counterparty !== "string" || counterparty.length > 200)) {
    return new Response("Invalid counterparty. Expected string (max 200 chars) or null", { status: 400 });
  }

  if (note !== null && (typeof note !== "string" || note.length > 1000)) {
    return new Response("Invalid note. Expected string (max 1000 chars) or null", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    const eventId = randomUUID();
    return Response.json({
      entryId: randomUUID(),
      eventId,
      ts: new Date(ts).toISOString(),
      accountId,
      amount,
      amountUsd: getDemoAmountUsd(amount, currency),
      currency,
      kind,
      category: category as string | null,
      counterparty: counterparty as string | null,
      note: note as string | null,
    });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const entry = await createLedgerEntry(userId, workspaceId, {
      ts,
      accountId,
      amount,
      currency,
      kind,
      category: category as string | null,
      counterparty: counterparty as string | null,
      note: note as string | null,
    });
    return Response.json(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("transactions-create POST: %s", message);
    return new Response("Database create failed", { status: 500 });
  }
};
