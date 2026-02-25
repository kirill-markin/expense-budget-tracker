import { isDemoModeFromRequest } from "@/lib/demoMode";
import { updateLedgerEntry } from "@/server/transactions/updateLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RequestBody = Readonly<{
  entryId: unknown;
  category: unknown;
  note: unknown;
}>;

export const POST = async (request: Request): Promise<Response> => {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { entryId, category, note } = body;

  if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 200) {
    return new Response("Invalid entryId. Expected non-empty string (max 200 chars)", { status: 400 });
  }

  if (category !== null && (typeof category !== "string" || category.length > 200)) {
    return new Response("Invalid category. Expected string (max 200 chars) or null", { status: 400 });
  }

  if (note !== null && (typeof note !== "string" || note.length > 1000)) {
    return new Response("Invalid note. Expected string (max 1000 chars) or null", { status: 400 });
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Database update failed: ${message}`, { status: 500 });
  }

  return Response.json({ ok: true });
};
