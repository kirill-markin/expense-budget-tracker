import { isDemoModeFromRequest } from "@/lib/demoMode";
import { updateLedgerEntry } from "@/server/transactions/updateLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RequestBody = Readonly<{
  entryId: unknown;
  category: unknown;
  note: unknown;
  counterparty: unknown;
  kind: unknown;
  ts: unknown;
  accountId: unknown;
  amount: unknown;
  currency: unknown;
}>;

const VALID_KINDS: ReadonlyArray<string> = ["income", "spend", "transfer"];

export const POST = async (request: Request): Promise<Response> => {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { entryId, category, note, counterparty, kind, ts, accountId, amount, currency } = body;

  if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 200) {
    return new Response("Invalid entryId. Expected non-empty string (max 200 chars)", { status: 400 });
  }

  if (category !== null && (typeof category !== "string" || category.length > 200)) {
    return new Response("Invalid category. Expected string (max 200 chars) or null", { status: 400 });
  }

  if (note !== null && (typeof note !== "string" || note.length > 1000)) {
    return new Response("Invalid note. Expected string (max 1000 chars) or null", { status: 400 });
  }

  if (counterparty !== null && (typeof counterparty !== "string" || counterparty.length > 200)) {
    return new Response("Invalid counterparty. Expected string (max 200 chars) or null", { status: 400 });
  }

  if (typeof kind !== "string" || !VALID_KINDS.includes(kind)) {
    return new Response("Invalid kind. Expected one of: income, spend, transfer", { status: 400 });
  }

  if (typeof ts !== "string" || isNaN(Date.parse(ts))) {
    return new Response("Invalid ts. Expected ISO 8601 date string", { status: 400 });
  }

  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 200) {
    return new Response("Invalid accountId. Expected non-empty string (max 200 chars)", { status: 400 });
  }

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return new Response("Invalid amount. Expected finite number", { status: 400 });
  }

  if (typeof currency !== "string" || currency.length === 0 || currency.length > 10) {
    return new Response("Invalid currency. Expected non-empty string (max 10 chars)", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    return Response.json({ ok: true });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    await updateLedgerEntry(userId, workspaceId, {
      entryId,
      category: category as string | null,
      note: note as string | null,
      counterparty: counterparty as string | null,
      kind: kind as string,
      ts: ts as string,
      accountId: accountId as string,
      amount: amount as number,
      currency: currency as string,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("transactions-update POST: %s", message);
    return new Response("Database update failed", { status: 500 });
  }

  return Response.json({ ok: true });
};
