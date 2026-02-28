/**
 * SQL query API endpoint with Bearer token (API key) authentication.
 *
 * POST /api/sql
 * Authorization: Bearer ebt_...
 * Content-Type: application/json
 * {"sql": "SELECT ..."}
 *
 * Does its own auth internally — no proxy headers needed. The API key is
 * validated, identity is resolved, and the query runs with full RLS via
 * withUserContext().
 *
 * Timeout: 30s (heavier analytical queries).
 * Row limit: 100 (same as chat).
 */
import { hashKey, touchApiKeyUsage, validateApiKey } from "@/server/apiKeys";
import { isDml, MAX_ROWS } from "@/server/chat/shared";
import { withUserContext } from "@/server/db";
import { log } from "@/server/logger";

const API_STATEMENT_TIMEOUT_MS = 30_000;

export const POST = async (request: Request): Promise<Response> => {
  const authHeader = request.headers.get("authorization");
  if (authHeader === null || !authHeader.startsWith("Bearer ")) {
    return Response.json({ error: "Missing or malformed Authorization header" }, { status: 401 });
  }

  const key = authHeader.slice("Bearer ".length);
  if (key === "" || !key.startsWith("ebt_")) {
    return Response.json({ error: "Invalid API key format" }, { status: 401 });
  }

  const identity = await validateApiKey(key);
  if (identity === null) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  let sql: string;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.sql !== "string" || body.sql.trim() === "") {
      return Response.json({ error: "Missing sql field" }, { status: 400 });
    }
    sql = body.sql;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isDml(sql)) {
    return Response.json(
      { error: "Only SELECT, WITH, INSERT, UPDATE, DELETE statements are allowed" },
      { status: 400 },
    );
  }

  const startMs = Date.now();

  try {
    const result = await withUserContext(
      identity.userId,
      identity.workspaceId,
      async (queryFn) => {
        await queryFn(
          `SET LOCAL statement_timeout = '${API_STATEMENT_TIMEOUT_MS}'`,
          [],
        );
        return queryFn(sql, []);
      },
    );

    const rows = result.rows.slice(0, MAX_ROWS);
    const durationMs = Date.now() - startMs;

    touchApiKeyUsage(hashKey(key));

    log({ domain: "sql-api", action: "query", durationMs, rowCount: rows.length });

    return Response.json({ rows, rowCount: rows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ domain: "sql-api", action: "error", error: message });
    return Response.json({ error: message }, { status: 500 });
  }
};
