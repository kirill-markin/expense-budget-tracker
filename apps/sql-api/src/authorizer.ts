/**
 * Lambda Authorizer for API Gateway (REST API, TOKEN type).
 *
 * Validates ebt_ Bearer tokens against the database using the same
 * SECURITY DEFINER function (validate_api_key) as the web app.
 * Returns an IAM policy + context with usageIdentifierKey for per-key
 * throttling via Usage Plans.
 *
 * API Gateway caches results for 5 minutes by Authorization header value.
 */

import crypto from "node:crypto";
import type { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from "aws-lambda";
import { query } from "./db";

const hashKey = (key: string): string =>
  crypto.createHash("sha256").update(key).digest("hex");

const denyPolicy = (methodArn: string): APIGatewayAuthorizerResult => ({
  principalId: "anonymous",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: methodArn }],
  },
});

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const token = event.authorizationToken ?? "";
  if (!token.startsWith("Bearer ebt_")) {
    return denyPolicy(event.methodArn);
  }

  const key = token.slice("Bearer ".length);
  const keyHash = hashKey(key);

  const result = await query("SELECT * FROM validate_api_key($1)", [keyHash]);
  if (result.rows.length === 0) {
    return denyPolicy(event.methodArn);
  }

  const row = result.rows[0] as { user_id: string; workspace_id: string };

  // Fire-and-forget: update last_used_at for usage tracking
  query("UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1", [keyHash]).catch(() => {});

  // Allow all methods on this API — cache applies to the whole API per token
  const arnParts = event.methodArn.split(":");
  const apiGatewayArnParts = arnParts[5].split("/");
  const resourceArn = `${arnParts.slice(0, 5).join(":")}:${apiGatewayArnParts[0]}/${apiGatewayArnParts[1]}/*`;

  return {
    principalId: row.user_id,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: resourceArn }],
    },
    context: {
      userId: row.user_id,
      workspaceId: row.workspace_id,
    },
    usageIdentifierKey: keyHash,
  };
};
