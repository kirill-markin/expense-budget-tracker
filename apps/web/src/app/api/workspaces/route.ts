import { queryAs } from "@/server/db";
import { extractUserId } from "@/server/userId";

type PostBody = Readonly<{
  name: unknown;
}>;

export const POST = async (request: Request): Promise<Response> => {
  let body: PostBody;
  try {
    body = await request.json() as PostBody;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const { name } = body;
  if (typeof name !== "string" || name.trim().length === 0) {
    return new Response("name is required and must be a non-empty string", { status: 400 });
  }

  const trimmedName = name.trim();
  if (trimmedName.length > 100) {
    return new Response("name must be 100 characters or fewer", { status: 400 });
  }

  const userId = extractUserId(request);
  try {
    const result = await queryAs(
      userId,
      userId,
      "SELECT workspace_id, name FROM create_workspace_for_current_user($1)",
      [trimmedName],
    );
    if (result.rows.length !== 1) {
      throw new Error(`create_workspace_for_current_user returned ${result.rows.length} rows`);
    }
    const row = result.rows[0] as { workspace_id: string; name: string };
    return Response.json({ workspaceId: row.workspace_id, name: row.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("workspaces POST: %s", message);
    return new Response("Failed to create workspace", { status: 500 });
  }
};
