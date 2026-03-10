import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { QueryResult } from "pg";
import { createAuthorizerHandler } from "./authorizer";

const hashSecret = (secret: string): string =>
  crypto.createHash("sha256").update(secret).digest("hex");

const createQueryResult = (rows: ReadonlyArray<unknown>): QueryResult =>
  ({
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: [...rows],
  }) as QueryResult;

test("createAuthorizerHandler accepts ApiKey agent credentials", async () => {
  const handler = createAuthorizerHandler({
    query: async (text: string): Promise<QueryResult> => {
      if (text.includes("validate_agent_api_key")) {
        return createQueryResult([{
            connection_id: "connection-1",
            user_id: "user-1",
            email: "user@example.com",
            key_hash: hashSecret("0123456789ABCDEFGHJKMNPQRS"),
            revoked_at: null,
            last_used_at: null,
            label: "codex-desktop",
            created_at: "2026-03-10T00:00:00.000Z",
          }]);
      }

      return createQueryResult([]);
    },
  });

  const response = await handler({
    type: "TOKEN",
    authorizationToken: "ApiKey ebta_abcd1234_0123456789ABCDEFGHJKMNPQRS",
    methodArn: "arn:aws:execute-api:eu-west-1:123456789012:api-id/v1/GET/me",
  });

  assert.equal(response.principalId, "user-1");
  assert.equal(response.context?.["email"], "user@example.com");
  assert.equal(response.usageIdentifierKey, "connection-1");
});

test("createAuthorizerHandler rejects legacy Bearer credentials", async () => {
  const handler = createAuthorizerHandler({
    query: async () => createQueryResult([]),
  });

  const response = await handler({
    type: "TOKEN",
    authorizationToken: "Bearer ebt_legacytoken",
    methodArn: "arn:aws:execute-api:eu-west-1:123456789012:api-id/v1/POST/sql",
  });

  assert.equal(response.policyDocument.Statement[0]?.Effect, "Deny");
});
