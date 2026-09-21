/**
 * Lambda Authorizer for API Gateway (REST API, TOKEN type).
 *
 * Validates agent ApiKey tokens with the shared validation in
 * ./agentApiKeyAuth.js and returns an IAM policy + context with
 * usageIdentifierKey for per-key throttling via Usage Plans.
 *
 * API Gateway authorizer caching is disabled: infra/aws/lib/api-gateway.ts
 * sets `resultsCacheTtl` to zero, so every request is validated here and a
 * revoked key is refused on the next request instead of after a cache window.
 */

import type { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from "aws-lambda";
import { validateAgentApiKeyAuthorization, type AgentApiKeyAuthDependencies } from "./agentApiKeyAuth.js";
import { query } from "./db.js";

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
  dependencies: AgentApiKeyAuthDependencies,
): ((event: APIGatewayTokenAuthorizerEvent) => Promise<APIGatewayAuthorizerResult>) => {
  return async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
    const authenticated = await validateAgentApiKeyAuthorization(event.authorizationToken ?? "", dependencies);
    if (authenticated === null) {
      return denyPolicy(event.methodArn);
    }

    const arnParts = event.methodArn.split(":");
    const apiGatewayArnParts = arnParts[5].split("/");
    const resourceArn = `${arnParts.slice(0, 5).join(":")}:${apiGatewayArnParts[0]}/${apiGatewayArnParts[1]}/*`;

    return {
      principalId: authenticated.userId,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: resourceArn }],
      },
      context: {
        userId: authenticated.userId,
        email: authenticated.email,
        connectionId: authenticated.connectionId,
        label: authenticated.label,
        createdAt: authenticated.createdAt,
        lastUsedAt: authenticated.lastUsedAt,
      },
      usageIdentifierKey: authenticated.connectionId,
    };
  };
};
