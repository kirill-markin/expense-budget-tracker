import { isDemoModeFromRequest } from "@/lib/demoMode";
import { upsertAccountMetadata } from "@/server/balances/upsertAccountMetadata";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

type RequestBody = Readonly<{
  accountId: unknown;
  liquidity: unknown;
}>;

const VALID_LIQUIDITY: ReadonlyArray<string> = ["high", "medium", "low"];

export const POST = async (request: Request): Promise<Response> => {
  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { accountId, liquidity } = body;

  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 200) {
    return new Response("Invalid accountId. Expected non-empty string (max 200 chars)", { status: 400 });
  }

  if (typeof liquidity !== "string" || !VALID_LIQUIDITY.includes(liquidity)) {
    return new Response("Invalid liquidity. Expected one of: high, medium, low", { status: 400 });
  }

  if (isDemoModeFromRequest(request)) {
    return Response.json({ ok: true });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    await upsertAccountMetadata(userId, workspaceId, {
      accountId: accountId as string,
      liquidity: liquidity as string,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("account-metadata POST: %s", message);
    return new Response("Database update failed", { status: 500 });
  }

  return Response.json({ ok: true });
};
