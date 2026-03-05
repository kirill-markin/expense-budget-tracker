/**
 * SQL executor Lambda for API Gateway (REST API).
 *
 * Receives pre-authenticated requests (userId/workspaceId from authorizer context),
 * validates the SQL statement, executes it with RLS context, and returns results.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { withTransaction } from "./db";

const MAX_ROWS = 100;
const STATEMENT_TIMEOUT_MS = 30_000;

const ALLOWED_FIRST_KEYWORDS = new Set([
  "SELECT", "WITH", "INSERT", "UPDATE", "DELETE",
]);

const isDml = (sql: string): boolean => {
  const first = sql.trimStart().split(/\s/)[0]?.toUpperCase();
  return first !== undefined && ALLOWED_FIRST_KEYWORDS.has(first);
};

/** Returns true if sql contains a semicolon outside of single-quoted strings. */
const hasMultipleStatements = (sql: string): boolean => {
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inString) {
      inString = true;
    } else if (ch === "'" && inString) {
      // PostgreSQL escapes quotes as '' inside strings
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        i++;
      } else {
        inString = false;
      }
    } else if (ch === ";" && !inString) {
      return true;
    }
  }
  return false;
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

  if (hasMultipleStatements(sql)) {
    return json(400, { error: "Multiple statements (semicolons) are not allowed" });
  }

  const containsSetConfig = (s: string): boolean => /\bset_config\b/i.test(s);

  if (containsSetConfig(sql)) {
    return json(400, { error: "set_config() calls are not allowed" });
  }

  try {
    const result = await withTransaction(userId, workspaceId, STATEMENT_TIMEOUT_MS, async (queryFn) => {
      return queryFn(sql, []);
    });

    const rows = result.rows.slice(0, MAX_ROWS);
    return json(200, { rows, rowCount: rows.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { error: message });
  }
};
