import crypto from "node:crypto";

import { getPool } from "@/server/db";
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
  const workspaceId = crypto.randomUUID();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);

    await client.query(
      "INSERT INTO workspaces (workspace_id, name) VALUES ($1, $2)",
      [workspaceId, trimmedName],
    );
    await client.query(
      "INSERT INTO workspace_members (workspace_id, user_id) VALUES ($1, $2)",
      [workspaceId, userId],
    );
    await client.query(
      "INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ($1, 'USD')",
      [workspaceId],
    );

    await client.query("COMMIT");
    return Response.json({ workspaceId, name: trimmedName });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Failed to create workspace: ${message}`, { status: 500 });
  } finally {
    client.release();
  }
};
