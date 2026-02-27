import { isDemoModeFromRequest } from "@/lib/demoMode";
import { deleteLedgerEntry } from "@/server/transactions/deleteLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RequestBody = Readonly<{
  entryId: unknown;
}>;

export const POST = async (request: Request): Promise<Response> => {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { entryId } = body;

  if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 200) {
    return new Response("Invalid entryId. Expected non-empty string (max 200 chars)", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    return Response.json({ ok: true });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    await deleteLedgerEntry(userId, workspaceId, entryId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("transactions-delete POST: %s", message);
    return new Response("Database delete failed", { status: 500 });
  }

  return Response.json({ ok: true });
};
