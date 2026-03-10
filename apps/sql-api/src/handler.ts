/**
 * SQL executor Lambda for API Gateway (REST API).
 *
 * Receives pre-authenticated requests (userId/workspaceId from authorizer context),
 * validates the SQL statement, executes it with RLS context, and returns results.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { withTransaction } from "./db";
import { executeExpenseSql, SQL_STATEMENT_TIMEOUT_MS, SqlPolicyError } from "../../web/src/server/sql/core";

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

  try {
    const result = await executeExpenseSql(
      sql,
      async (validatedSql) => withTransaction(
        userId,
        workspaceId,
        SQL_STATEMENT_TIMEOUT_MS,
        async (queryFn) => queryFn(validatedSql, []),
      ),
    );

    return json(200, { rows: result.rows, rowCount: result.rowCount });
  } catch (error) {
    if (error instanceof SqlPolicyError) {
      return json(400, { error: error.message });
    }

    const message = error instanceof Error ? error.message : String(error);
    return json(500, { error: message });
  }
};
