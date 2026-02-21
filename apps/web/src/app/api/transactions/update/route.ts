import { updateLedgerEntry } from "@/server/transactions/updateLedgerEntry";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RequestBody = Readonly<{
  entryId: unknown;
  category: unknown;
  note: unknown;
}>;

export const POST = async (request: Request): Promise<Response> => {
  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { entryId, category, note } = body;

  if (typeof entryId !== "string" || entryId.length === 0) {
    return new Response("Invalid entryId. Expected non-empty string", { status: 400 });
  }

  if (category !== null && typeof category !== "string") {
    return new Response("Invalid category. Expected string or null", { status: 400 });
  }

  if (note !== null && typeof note !== "string") {
    return new Response("Invalid note. Expected string or null", { status: 400 });
  }

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
