/**
 * Lambda Authorizer for API Gateway (REST API, TOKEN type).
 *
 * Validates agent ApiKey tokens against the database using the same
 * SECURITY DEFINER function (auth.validate_agent_api_key) as the web app.
 * Returns an IAM policy + context with usageIdentifierKey for per-key
 * throttling via Usage Plans.
 *
 * API Gateway caches results for 5 minutes by Authorization header value.
 */

import crypto from "node:crypto";
import { normalizeCrockfordToken } from "@expense-budget-tracker/agent-shared/crockford";
import type { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from "aws-lambda";
import { query } from "./db.js";

type AuthorizerDependencies = Readonly<{
  query: typeof query;
}>;

type AgentApiKeyRow = Readonly<{
  connection_id: string;
  user_id: string;
  email: string | null;
  key_hash: string;
  revoked_at: string | null;
  last_used_at: string | null;
  label: string;
  created_at: string;
}>;

const KEY_PREFIX = "EBTA";
const KEY_ID_LENGTH = 8;
const SECRET_LENGTH = 26;

const hashSecret = (secret: string): string =>
  crypto.createHash("sha256").update(secret).digest("hex");

const denyPolicy = (methodArn: string): APIGatewayAuthorizerResult => ({
  principalId: "anonymous",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: methodArn }],
  },
});

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => createAuthorizerHandler({ query })(event);

export const createAuthorizerHandler = (
  dependencies: AuthorizerDependencies,
): ((event: APIGatewayTokenAuthorizerEvent) => Promise<APIGatewayAuthorizerResult>) => {
  return async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
    const token = event.authorizationToken ?? "";
    if (!token.startsWith("ApiKey ")) {
      return denyPolicy(event.methodArn);
    }

    const credentials = token.slice("ApiKey ".length).replace(/[\s-]/g, "").toUpperCase();
    const parts = credentials.split("_");
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
      return denyPolicy(event.methodArn);
    }

    let keyId = "";
    let secret = "";
    try {
      keyId = normalizeCrockfordToken(parts[1] ?? "", "agent ApiKey keyId");
      secret = normalizeCrockfordToken(parts[2] ?? "", "agent ApiKey secret");
    } catch {
      return denyPolicy(event.methodArn);
    }

    if (keyId.length !== KEY_ID_LENGTH || secret.length !== SECRET_LENGTH) {
      return denyPolicy(event.methodArn);
    }

    const result = await dependencies.query("SELECT * FROM auth.validate_agent_api_key($1)", [keyId]);
    if (result.rows.length !== 1) {
      return denyPolicy(event.methodArn);
    }

    const row = result.rows[0] as AgentApiKeyRow;
    if (row.revoked_at !== null || row.email === null || row.email === "" || row.key_hash !== hashSecret(secret)) {
      return denyPolicy(event.methodArn);
    }

    dependencies.query("SELECT auth.touch_agent_api_key_usage($1)", [row.connection_id]).catch(() => {});

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
        email: row.email,
        connectionId: row.connection_id,
        label: row.label,
        createdAt: String(row.created_at),
        lastUsedAt: row.last_used_at === null ? "" : String(row.last_used_at),
      },
      usageIdentifierKey: row.connection_id,
    };
  };
};
