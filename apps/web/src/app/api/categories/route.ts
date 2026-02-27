import { isDemoModeFromRequest } from "@/lib/demoMode";
import { getDemoCategories } from "@/server/demo/data";
import { getCategories } from "@/server/transactions/getTransactions";
import { extractUserId, extractWorkspaceId } from "@/server/userId";

export const GET = async (request: Request): Promise<Response> => {
  if (isDemoModeFromRequest(request)) {
    return Response.json({ categories: getDemoCategories() });
  }

  const userId = extractUserId(request);
  const workspaceId = extractWorkspaceId(request);

  try {
    const categories = await getCategories(userId, workspaceId);
    return Response.json({ categories });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("categories GET: %s", message);
    return new Response("Database query failed", { status: 500 });
  }
};
