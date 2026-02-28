/**
 * SQL executor Lambda for API Gateway (REST API).
 *
 * Receives pre-authenticated requests (userId/workspaceId from authorizer context),
 * validates the SQL statement, executes it with RLS context, and returns results.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { query } from "./db";

const MAX_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 30_000;

const ALLOWED_FIRST_KEYWORDS = new Set([
  "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
]);

const isDml = (sql: string): boolean => {
  const first = sql.trimStart().split(/\s/)[0]?.toUpperCase();
  return first !== undefined && ALLOWED_FIRST_KEYWORDS.has(first);
};

const json = (statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // Identity injected by Lambda Authorizer via API Gateway context
  const userId = event.requestContext.authorizer?.["userId"] as string | undefined;
  const workspaceId = event.requestContext.authorizer?.["workspaceId"] as string | undefined;

  if (!userId || !workspaceId) {
    return json(401, { error: "Missing identity context" });
  }

  let sql: string;
  try {
    const body = JSON.parse(event.body ?? "{}") as Record<string, unknown>;
    if (typeof body.sql !== "string" || body.sql.trim() === "") {
      return json(400, { error: "Missing sql field" });
    }
    sql = body.sql;
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  if (!isDml(sql)) {
    return json(400, { error: "Only SELECT, WITH, INSERT, UPDATE, DELETE statements are allowed" });
  }

  try {
    await query("BEGIN", []);
    await query(`SET LOCAL app.user_id = '${userId}'`, []);
    await query(`SET LOCAL app.workspace_id = '${workspaceId}'`, []);
    await query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}'`, []);
    const result = await query(sql, []);
    await query("COMMIT", []);

    const rows = result.rows.slice(0, MAX_ROWS);
    return json(200, { rows, rowCount: rows.length });
  } catch (error) {
    await query("ROLLBACK", []).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { error: message });
  }
};
