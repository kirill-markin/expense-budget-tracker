import { createHash } from "node:crypto";
import type { SqlExecutionDeadline } from "@expense-budget-tracker/agent-shared/sql-policy";
import { z } from "zod";
import {
  loadTrustedUserIdentityBeforeDeadline,
  queryBeforeDeadline,
  type UserIdentity,
} from "../db.js";
import type { McpScope } from "./config.js";

const ACCESS_TOKEN_PATTERN = /^ebt_at_[A-Za-z0-9_-]{43}$/u;

const accessTokenRowSchema = z.object({
  connection_id: z.string().min(1),
  user_id: z.string().min(1),
  client_id: z.string().min(1),
  resource: z.string().min(1),
  scopes: z.array(z.string().min(1)),
  expires_at: z.union([z.date(), z.string().min(1)]),
});

export type AuthenticatedMcpAccessToken = Readonly<{
  connectionId: string;
  clientId: string;
  resource: string;
  scopes: ReadonlyArray<McpScope>;
  identity: UserIdentity;
}>;

export class McpAuthenticationError extends Error {
  constructor() {
    super("Invalid OAuth access token");
  }
}

export type McpAuthDependencies = Readonly<{
  queryBeforeDeadline: typeof queryBeforeDeadline;
  loadTrustedUserIdentityBeforeDeadline: typeof loadTrustedUserIdentityBeforeDeadline;
  now: () => Date;
}>;

const defaultDependencies: McpAuthDependencies = {
  queryBeforeDeadline,
  loadTrustedUserIdentityBeforeDeadline,
  now: () => new Date(),
};

const hashAccessToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const readExpirationTime = (value: Date | string): number => {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("validate_oauth_access_token returned an invalid expires_at value");
  }
  return timestamp;
};

const readCanonicalScopeSnapshot = (
  scopes: ReadonlyArray<string>,
): ReadonlyArray<McpScope> => {
  if (scopes.length === 1 && scopes[0] === "expenses:read") {
    return ["expenses:read"];
  }
  if (
    scopes.length === 2
    && scopes[0] === "expenses:read"
    && scopes[1] === "expenses:write"
  ) {
    return ["expenses:read", "expenses:write"];
  }
  throw new McpAuthenticationError();
};

export const authenticateMcpAccessTokenWithDependencies = async (
  token: string,
  expectedResource: string,
  deadline: SqlExecutionDeadline,
  dependencies: McpAuthDependencies,
): Promise<AuthenticatedMcpAccessToken> => {
  if (!ACCESS_TOKEN_PATTERN.test(token)) {
    throw new McpAuthenticationError();
  }

  const result = await dependencies.queryBeforeDeadline(
    `SELECT connection_id, user_id, client_id, resource, scopes, expires_at
     FROM auth.validate_oauth_access_token($1)`,
    [hashAccessToken(token)],
    deadline,
  );
  if (result.rows.length !== 1) {
    throw new McpAuthenticationError();
  }

  const parsed = accessTokenRowSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    throw new Error("validate_oauth_access_token returned an invalid access-token row");
  }
  const row = parsed.data;
  const scopes = readCanonicalScopeSnapshot(row.scopes);
  if (
    row.resource !== expectedResource
    || readExpirationTime(row.expires_at) <= dependencies.now().getTime()
  ) {
    throw new McpAuthenticationError();
  }

  const identity = await dependencies.loadTrustedUserIdentityBeforeDeadline(
    row.user_id,
    deadline,
  );
  if (
    identity === null
    || identity.userId !== row.user_id
    || !identity.emailVerified
    || !identity.cognitoEnabled
    || identity.cognitoStatus !== "CONFIRMED"
  ) {
    throw new McpAuthenticationError();
  }

  return {
    connectionId: row.connection_id,
    clientId: row.client_id,
    resource: row.resource,
    scopes,
    identity,
  };
};

export const authenticateMcpAccessToken = (
  token: string,
  expectedResource: string,
  deadline: SqlExecutionDeadline,
): Promise<AuthenticatedMcpAccessToken> =>
  authenticateMcpAccessTokenWithDependencies(
    token,
    expectedResource,
    deadline,
    defaultDependencies,
  );
