import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { QueryResult, QueryResultRow } from "pg";
import type { QueryFn } from "../db.js";
import {
  getOAuthOwnerPolicy,
  type OAuthOwnerPolicy,
  type OAuthOwnerStatus,
} from "./owner.js";
import {
  exchangeAuthorizationCodeWithDependencies,
  exchangeRefreshTokenWithDependencies,
  issueAuthorizationCodeWithDependencies,
  registerOAuthClientWithDependencies,
  type OAuthStoreDependencies,
} from "./store.js";
import { isOAuthProtocolError, type AuthorizationRequest } from "./core.js";

type QueryCall = Readonly<{ text: string; params: ReadonlyArray<unknown> }>;

const result = (rows: Array<QueryResultRow>): QueryResult<QueryResultRow> => ({
  command: "",
  rowCount: rows.length,
  oid: 0,
  rows,
  fields: [],
});

const isOAuthCleanupQuery = (text: string): boolean =>
  text === "SELECT auth.cleanup_expired_oauth_transient_state()";

const isOAuthActivityQuery = (text: string): boolean =>
  text === "SELECT auth.record_oauth_connection_activity($1)";

const cleanupMigration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0069_oauth_transient_state_cleanup.sql", import.meta.url)),
  "utf8",
);

const tombstoneRetentionMigration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0070_oauth_used_credential_tombstone_retention.sql", import.meta.url)),
  "utf8",
);

const revokedCleanupQueueMigration = readFileSync(
  fileURLToPath(new URL("../../../../../db/migrations/0071_oauth_revoked_connection_cleanup_queue.sql", import.meta.url)),
  "utf8",
);

const readMigrationSection = (migration: string, marker: string): string => {
  const markerIndex = migration.indexOf(marker);
  if (markerIndex === -1) throw new Error(`OAuth cleanup migration is missing ${marker}`);
  return migration.slice(markerIndex);
};

const readMigrationRange = (migration: string, startMarker: string, endMarker: string): string => {
  const startIndex = migration.indexOf(startMarker);
  const endIndex = migration.indexOf(endMarker);
  if (startIndex === -1) throw new Error(`OAuth cleanup migration is missing ${startMarker}`);
  if (endIndex <= startIndex) throw new Error(`OAuth cleanup migration is missing ${endMarker} after ${startMarker}`);
  return migration.slice(startIndex, endIndex);
};

const cleanupFunctionSql = readMigrationSection(
  revokedCleanupQueueMigration,
  "CREATE OR REPLACE FUNCTION auth.cleanup_expired_oauth_transient_state()",
);

const ownerListingFunctionSql = readMigrationRange(
  cleanupMigration,
  "CREATE OR REPLACE FUNCTION auth.list_current_user_oauth_connections()",
  "CREATE FUNCTION auth.record_oauth_connection_activity(p_connection_id TEXT)",
);

/**
 * A policy that answers the owner check as the test dictates while keeping the
 * real `cognito` mirror write, which most cases here assert on.
 */
const ownerPolicyReading = (
  readOwnerStatus: (userId: string) => Promise<OAuthOwnerStatus>,
): OAuthOwnerPolicy => ({
  ...getOAuthOwnerPolicy("cognito"),
  readOwnerStatus: (userId: string): Promise<OAuthOwnerStatus> => readOwnerStatus(userId),
});

const createDependencies = (
  queryFn: QueryFn,
  tokens: Readonly<Record<"cl" | "ac" | "at" | "rt", ReadonlyArray<string>>>,
): OAuthStoreDependencies => {
  const offsets: Record<"cl" | "ac" | "at" | "rt", number> = { cl: 0, ac: 0, at: 0, rt: 0 };
  return {
    query: async (text, params) => isOAuthCleanupQuery(text) ? result([]) : queryFn(text, params),
    withTransaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => callback(queryFn),
    createOpaqueToken: (prefix) => {
      const token = tokens[prefix][offsets[prefix]];
      if (token === undefined) throw new Error(`Missing test token for ${prefix}`);
      offsets[prefix] += 1;
      return token;
    },
    ownerPolicy: ownerPolicyReading(async () => "active"),
  };
};

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const emptyTokens = (): Readonly<Record<"cl" | "ac" | "at" | "rt", ReadonlyArray<string>>> => ({
  cl: [], ac: [], at: [], rt: [],
});

const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorizationRequest: AuthorizationRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://client.example/callback",
  scope: "expenses:read expenses:write",
  scopes: ["expenses:read", "expenses:write"],
  resource: "https://mcp.example.com/mcp",
  state: "state-1",
  codeChallenge: challenge,
  codeChallengeMethod: "S256",
};

test("OAuth cleanup retains active-family tombstones and fairly bounds revoked-family work", (): void => {
  assert.match(
    tombstoneRetentionMigration,
    /CREATE INDEX idx_oauth_connections_revoked_connection_id\s+ON auth\.oauth_connections \(connection_id\)\s+WHERE revoked_at IS NOT NULL/u,
  );
  assert.match(
    tombstoneRetentionMigration,
    /CREATE INDEX idx_oauth_authorization_codes_unused_expires_at\s+ON auth\.oauth_authorization_codes \(expires_at, code_hash\)\s+WHERE used_at IS NULL/u,
  );
  assert.match(
    tombstoneRetentionMigration,
    /CREATE INDEX idx_oauth_refresh_tokens_unused_expires_at\s+ON auth\.oauth_refresh_tokens \(expires_at, token_hash\)\s+WHERE used_at IS NULL/u,
  );
  assert.match(
    revokedCleanupQueueMigration,
    /CREATE TABLE auth\.oauth_revoked_connection_cleanup_queue/u,
  );
  assert.match(
    revokedCleanupQueueMigration,
    /CREATE UNIQUE INDEX idx_oauth_revoked_cleanup_queue_position\s+ON auth\.oauth_revoked_connection_cleanup_queue \(queue_position\)/u,
  );
  assert.match(
    revokedCleanupQueueMigration,
    /AFTER UPDATE OF revoked_at ON auth\.oauth_connections/u,
  );
  assert.match(
    revokedCleanupQueueMigration,
    /WHERE connection\.revoked_at IS NOT NULL[\s\S]*authorization_code\.used_at IS NOT NULL[\s\S]*refresh_token\.used_at IS NOT NULL/u,
  );
  assert.match(
    cleanupFunctionSql,
    /FROM auth\.oauth_revoked_connection_cleanup_queue AS queued_connection\s+ORDER BY queued_connection\.queue_position\s+LIMIT 1\s+FOR UPDATE SKIP LOCKED/u,
  );
  assert.equal(cleanupFunctionSql.match(/used_at IS NULL/gu)?.length, 2);
  assert.equal(cleanupFunctionSql.match(/connection_id = v_cleanup_connection_id/gu)?.length, 4);
  assert.equal(cleanupFunctionSql.match(/GET DIAGNOSTICS v_deleted_count = ROW_COUNT/gu)?.length, 2);
  assert.equal(cleanupFunctionSql.match(/LIMIT 100/gu)?.length, 3);
  assert.equal(cleanupFunctionSql.match(/LIMIT \(100 - v_deleted_count\)/gu)?.length, 2);
  assert.equal(cleanupFunctionSql.match(/FOR UPDATE SKIP LOCKED/gu)?.length, 6);
  assert.equal(cleanupFunctionSql.match(/DELETE FROM auth\.oauth_authorization_codes/gu)?.length, 2);
  assert.match(cleanupFunctionSql, /DELETE FROM auth\.oauth_access_tokens/u);
  assert.equal(cleanupFunctionSql.match(/DELETE FROM auth\.oauth_refresh_tokens/gu)?.length, 2);
  assert.match(cleanupFunctionSql, /DELETE FROM auth\.oauth_revoked_connection_cleanup_queue/u);
  assert.match(
    cleanupFunctionSql,
    /SET queue_position = nextval\('auth\.oauth_revoked_cleanup_queue_position_seq'::regclass\)/u,
  );
  assert.doesNotMatch(cleanupFunctionSql, /FROM auth\.oauth_connections/u);
  assert.doesNotMatch(cleanupFunctionSql, /INTERVAL '30 days'/u);
  assert.match(cleanupFunctionSql, /SECURITY DEFINER/u);
  assert.match(revokedCleanupQueueMigration, /GRANT EXECUTE ON FUNCTION auth\.cleanup_expired_oauth_transient_state\(\) TO auth_service/u);
  assert.doesNotMatch(revokedCleanupQueueMigration, /GRANT DELETE/u);
});

test("OAuth activity is backfilled durably and read without transient credential rows", (): void => {
  assert.match(cleanupMigration, /ADD COLUMN last_activity_at TIMESTAMPTZ/u);
  assert.match(cleanupMigration, /max\(event\.used_at\) AS last_activity_at/u);
  assert.match(cleanupMigration, /FROM auth\.oauth_authorization_codes AS code/u);
  assert.match(cleanupMigration, /FROM auth\.oauth_refresh_tokens AS refresh_token/u);
  assert.match(cleanupMigration, /CREATE OR REPLACE FUNCTION auth\.list_current_user_oauth_connections\(\)/u);
  assert.match(ownerListingFunctionSql, /connection\.last_activity_at/u);
  assert.match(ownerListingFunctionSql, /WHERE connection\.user_id = v_user_id/u);
  assert.doesNotMatch(ownerListingFunctionSql, /oauth_authorization_codes|oauth_refresh_tokens|LATERAL/u);
  assert.match(cleanupMigration, /REVOKE ALL ON FUNCTION auth\.list_current_user_oauth_connections\(\) FROM PUBLIC/u);
  assert.match(cleanupMigration, /GRANT EXECUTE ON FUNCTION auth\.list_current_user_oauth_connections\(\) TO app/u);
  assert.match(cleanupMigration, /CREATE FUNCTION auth\.record_oauth_connection_activity\(p_connection_id TEXT\)/u);
  assert.match(
    cleanupMigration,
    /SET last_activity_at = GREATEST\(\s*COALESCE\(connection\.last_activity_at, '-infinity'::TIMESTAMPTZ\),\s*clock_timestamp\(\)\s*\)/u,
  );
  assert.match(cleanupMigration, /REVOKE ALL ON FUNCTION auth\.record_oauth_connection_activity\(TEXT\) FROM PUBLIC/u);
  assert.match(cleanupMigration, /GRANT EXECUTE ON FUNCTION auth\.record_oauth_connection_activity\(TEXT\) TO auth_service/u);
  assert.equal(
    cleanupMigration.indexOf("SET last_activity_at = activity.last_activity_at")
      < cleanupMigration.indexOf("CREATE FUNCTION auth.cleanup_expired_oauth_transient_state()"),
    true,
  );
});

test("authorization-code issuance cleans expired state before opening its transaction", async (): Promise<void> => {
  const sequence: Array<string> = [];
  let transactionOpen = false;
  const transactionQuery: QueryFn = async (text) => {
    assert.equal(transactionOpen, true);
    if (text.startsWith("SELECT auth.sync_authenticated_user")) sequence.push("sync_user");
    if (text.startsWith("INSERT INTO auth.oauth_connections")) {
      sequence.push("upsert_connection");
      return result([{ connection_id: "connection-1" }]);
    }
    if (text.startsWith("INSERT INTO auth.oauth_authorization_codes")) sequence.push("insert_code");
    return result([]);
  };
  const baseDependencies = createDependencies(
    transactionQuery,
    { ...emptyTokens(), ac: ["ebt_ac_cleanup-order"] },
  );
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    query: async (text) => {
      assert.equal(isOAuthCleanupQuery(text), true);
      assert.equal(transactionOpen, false);
      sequence.push("cleanup");
      return result([]);
    },
    withTransaction: async <T>(callback: (queryFn: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpen = true;
      try {
        return await callback(transactionQuery);
      } finally {
        transactionOpen = false;
      }
    },
    ownerPolicy: ownerPolicyReading(async (userId) => {
      assert.equal(userId, "user-1");
      assert.equal(transactionOpen, false);
      sequence.push("validate_owner");
      return "active";
    }),
  };

  await issueAuthorizationCodeWithDependencies(
    authorizationRequest,
    "user-1",
    "user@example.com",
    dependencies,
  );

  assert.deepEqual(sequence, ["cleanup", "validate_owner", "sync_user", "upsert_connection", "insert_code"]);
});

test("cleanup failures abort issuance before a transaction opens", async (): Promise<void> => {
  const cleanupFailure = new Error("OAuth cleanup failed");
  let transactionOpened = false;
  const baseDependencies = createDependencies(async () => result([]), emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    query: async (text) => {
      assert.equal(isOAuthCleanupQuery(text), true);
      throw cleanupFailure;
    },
    withTransaction: async <T>(callback: (queryFn: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(async () => result([]));
    },
  };

  await assert.rejects(
    issueAuthorizationCodeWithDependencies(
      authorizationRequest,
      "user-1",
      "user@example.com",
      dependencies,
    ),
    (error: unknown) => error === cleanupFailure,
  );
  assert.equal(transactionOpened, false);
});

test("inactive owners are revoked before browser identity can sync or issue an authorization code", async (): Promise<void> => {
  let transactionOpened = false;
  let revokedUserId: string | undefined;
  const baseDependencies = createDependencies(async (text, params) => {
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      assert.match(text, /WHERE user_id = \$1 AND revoked_at IS NULL/u);
      const userId = params[0];
      if (typeof userId !== "string") throw new Error("Inactive owner revocation expected a user ID");
      revokedUserId = userId;
    }
    if (text.startsWith("SELECT auth.sync_authenticated_user")) {
      throw new Error("Inactive browser identity must not sync the local Cognito mirror");
    }
    return result([]);
  }, emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    withTransaction: async <T>(callback: (queryFn: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(async () => result([]));
    },
    ownerPolicy: ownerPolicyReading(async (userId) => {
      assert.equal(userId, "user-1");
      return "inactive";
    }),
  };

  await assert.rejects(
    issueAuthorizationCodeWithDependencies(
      authorizationRequest,
      "user-1",
      "user@example.com",
      dependencies,
    ),
    (error: unknown) => isOAuthProtocolError(error)
      && error.oauthCode === "access_denied"
      && error.status === 400,
  );
  assert.equal(revokedUserId, "user-1");
  assert.equal(transactionOpened, false);
});

test("authorization-code exchange cleanup failure precedes every exchange side effect", async (): Promise<void> => {
  const cleanupFailure = new Error("OAuth cleanup failed before code exchange");
  let transactionOpened = false;
  let credentialConsumed = false;
  let cognitoCalled = false;
  let tokenIssued = false;
  let connectionRevoked = false;
  let activityRecorded = false;
  const transactionQuery: QueryFn = async (text) => {
    if (text.startsWith("UPDATE auth.oauth_authorization_codes")) credentialConsumed = true;
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens") || text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
      tokenIssued = true;
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) connectionRevoked = true;
    if (isOAuthActivityQuery(text)) activityRecorded = true;
    return result([]);
  };
  const baseDependencies = createDependencies(transactionQuery, emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    query: async (text) => {
      assert.equal(isOAuthCleanupQuery(text), true);
      throw cleanupFailure;
    },
    withTransaction: async <T>(callback: (queryFn: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(transactionQuery);
    },
    ownerPolicy: ownerPolicyReading(async () => {
      cognitoCalled = true;
      return "active";
    }),
  };

  await assert.rejects(
    exchangeAuthorizationCodeWithDependencies(
      "ebt_ac_cleanup-failure",
      authorizationRequest.clientId,
      authorizationRequest.redirectUri,
      authorizationRequest.resource,
      verifier,
      dependencies,
    ),
    (error: unknown) => error === cleanupFailure,
  );
  assert.equal(transactionOpened, false);
  assert.equal(credentialConsumed, false);
  assert.equal(cognitoCalled, false);
  assert.equal(tokenIssued, false);
  assert.equal(connectionRevoked, false);
  assert.equal(activityRecorded, false);
});

test("inactive owners cannot exchange authorization codes and lose every active connection", async (): Promise<void> => {
  let transactionOpened = false;
  let credentialConsumed = false;
  let tokenIssued = false;
  let activityRecorded = false;
  let revokedUserId: string | undefined;
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_authorization_codes")) {
      assert.doesNotMatch(text, /FOR UPDATE/u);
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        redirect_uri: authorizationRequest.redirectUri,
        code_challenge: challenge,
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      assert.match(text, /WHERE user_id = \$1 AND revoked_at IS NULL/u);
      const userId = params[0];
      if (typeof userId !== "string") throw new Error("Inactive owner revocation expected a user ID");
      revokedUserId = userId;
    }
    if (text.startsWith("UPDATE auth.oauth_authorization_codes")) credentialConsumed = true;
    if (text.startsWith("INSERT INTO auth.oauth_")) tokenIssued = true;
    if (isOAuthActivityQuery(text)) activityRecorded = true;
    return result([]);
  };
  const baseDependencies = createDependencies(queryFn, emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    withTransaction: async <T>(callback: (queryFn: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(queryFn);
    },
    ownerPolicy: ownerPolicyReading(async (userId) => {
      assert.equal(userId, "user-1");
      return "inactive";
    }),
  };

  await assert.rejects(
    exchangeAuthorizationCodeWithDependencies(
      "ebt_ac_inactive-owner",
      authorizationRequest.clientId,
      authorizationRequest.redirectUri,
      authorizationRequest.resource,
      verifier,
      dependencies,
    ),
    (error: unknown) => isOAuthProtocolError(error)
      && error.oauthCode === "invalid_grant"
      && error.status === 400,
  );
  assert.equal(revokedUserId, "user-1");
  assert.equal(transactionOpened, false);
  assert.equal(credentialConsumed, false);
  assert.equal(tokenIssued, false);
  assert.equal(activityRecorded, false);
});

test("refresh exchange cleanup failure precedes every rotation side effect", async (): Promise<void> => {
  const cleanupFailure = new Error("OAuth cleanup failed before refresh exchange");
  let transactionOpened = false;
  let credentialConsumed = false;
  let cognitoCalled = false;
  let tokenIssued = false;
  let connectionRevoked = false;
  let activityRecorded = false;
  const transactionQuery: QueryFn = async (text) => {
    if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) credentialConsumed = true;
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens") || text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
      tokenIssued = true;
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) connectionRevoked = true;
    if (isOAuthActivityQuery(text)) activityRecorded = true;
    return result([]);
  };
  const baseDependencies = createDependencies(transactionQuery, emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    query: async (text) => {
      assert.equal(isOAuthCleanupQuery(text), true);
      throw cleanupFailure;
    },
    withTransaction: async <T>(callback: (queryFn: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(transactionQuery);
    },
    ownerPolicy: ownerPolicyReading(async () => {
      cognitoCalled = true;
      return "active";
    }),
  };

  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_cleanup-failure",
      authorizationRequest.clientId,
      authorizationRequest.resource,
      null,
      dependencies,
    ),
    (error: unknown) => error === cleanupFailure,
  );
  assert.equal(transactionOpened, false);
  assert.equal(credentialConsumed, false);
  assert.equal(cognitoCalled, false);
  assert.equal(tokenIssued, false);
  assert.equal(connectionRevoked, false);
  assert.equal(activityRecorded, false);
});

test("DCR and authorization-code issuance persist identifiers but only code hashes", async (): Promise<void> => {
  const calls: Array<QueryCall> = [];
  const queryFn: QueryFn = async (text, params) => {
    calls.push({ text, params });
    if (text.includes("RETURNING connection_id")) return result([{ connection_id: "connection-1" }]);
    return result([]);
  };
  const tokens = { ...emptyTokens(), cl: ["ebt_cl_plain-client"], ac: ["ebt_ac_plain-code"] };
  const dependencies = createDependencies(queryFn, tokens);

  const client = await registerOAuthClientWithDependencies("Desktop", [authorizationRequest.redirectUri], dependencies);
  const code = await issueAuthorizationCodeWithDependencies(authorizationRequest, "user-1", "user@example.com", dependencies);

  assert.equal(client.clientId, "ebt_cl_plain-client");
  assert.equal(code, "ebt_ac_plain-code");
  const codeInsert = calls.find((call) => call.text.includes("oauth_authorization_codes"));
  assert.ok(codeInsert);
  assert.equal(codeInsert.params[0], hash(code));
  assert.deepEqual(codeInsert.params[4], authorizationRequest.scopes);
  assert.equal(calls.some((call) => call.params.includes(code)), false);
});

test("authorization-code replay revokes the family and its previously minted credentials", async (): Promise<void> => {
  let used = false;
  let connectionRevoked = false;
  let preflightReadCount = 0;
  let lockedReadCount = 0;
  let activityCount = 0;
  let storedRefreshTokenHash: string | null = null;
  const accessTokenHashes = new Set<string>();
  const tokenInserts: Array<QueryCall> = [];
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_authorization_codes")) {
      if (text.includes("FOR UPDATE OF oac, oc")) lockedReadCount += 1;
      else preflightReadCount += 1;
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        redirect_uri: authorizationRequest.redirectUri,
        code_challenge: challenge,
        scopes: authorizationRequest.scopes,
        used,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: connectionRevoked,
      }]);
    }
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      return params[0] === storedRefreshTokenHash ? result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: connectionRevoked,
      }]) : result([]);
    }
    if (text.startsWith("UPDATE auth.oauth_authorization_codes")) used = true;
    if (isOAuthActivityQuery(text)) {
      assert.equal(used, true);
      assert.equal(params[0], "connection-1");
      activityCount += 1;
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      connectionRevoked = true;
      return result([{ connection_id: "connection-1" }]);
    }
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens")) {
      tokenInserts.push({ text, params });
      accessTokenHashes.add(params[0] as string);
    }
    if (text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
      tokenInserts.push({ text, params });
      storedRefreshTokenHash = params[0] as string;
    }
    return result([]);
  };
  const accessToken = "ebt_at_plain-access";
  const refreshToken = "ebt_rt_plain-refresh";
  const dependencies = createDependencies(queryFn, { ...emptyTokens(), at: [accessToken], rt: [refreshToken] });

  const issued = await exchangeAuthorizationCodeWithDependencies(
    "ebt_ac_presented", authorizationRequest.clientId, authorizationRequest.redirectUri,
    authorizationRequest.resource, verifier, dependencies,
  );

  assert.equal(issued.scope, authorizationRequest.scope);
  assert.equal(activityCount, 1);
  assert.equal(preflightReadCount, 1);
  assert.equal(lockedReadCount, 1);
  assert.deepEqual(tokenInserts.map((call) => call.params[2]), [authorizationRequest.scopes, authorizationRequest.scopes]);
  assert.deepEqual(tokenInserts.map((call) => call.params[0]), [hash(accessToken), hash(refreshToken)]);
  assert.equal(tokenInserts.some((call) => call.params.includes(accessToken) || call.params.includes(refreshToken)), false);
  await assert.rejects(
    exchangeAuthorizationCodeWithDependencies(
      "ebt_ac_presented", authorizationRequest.clientId, authorizationRequest.redirectUri,
      authorizationRequest.resource, verifier, dependencies,
    ),
    /already used/u,
  );
  assert.equal(activityCount, 1);
  assert.equal(preflightReadCount, 2);
  assert.equal(lockedReadCount, 2);
  assert.equal(accessTokenHashes.has(hash(issued.accessToken)) && !connectionRevoked, false);
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      issued.refreshToken, authorizationRequest.clientId, authorizationRequest.resource,
      null, dependencies,
    ),
    /invalid, expired, or already used/u,
  );
});

test("unknown and unused misbound credentials do not revoke a connection", async (): Promise<void> => {
  const knownCode = "ebt_ac_known-unused";
  const knownRefreshToken = "ebt_rt_known-unused";
  let revocationAttempted = false;
  let activityAttempted = false;
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_authorization_codes")) {
      if (params[0] !== hash(knownCode)) return result([]);
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        redirect_uri: authorizationRequest.redirectUri,
        code_challenge: challenge,
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      if (params[0] !== hash(knownRefreshToken)) return result([]);
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) revocationAttempted = true;
    if (isOAuthActivityQuery(text)) activityAttempted = true;
    return result([]);
  };
  const dependencies = createDependencies(queryFn, emptyTokens());

  await assert.rejects(
    exchangeAuthorizationCodeWithDependencies(
      knownCode, "mismatched-client", authorizationRequest.redirectUri,
      authorizationRequest.resource, verifier, dependencies,
    ),
    /binding validation failed/u,
  );
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      knownRefreshToken, authorizationRequest.clientId, "https://mcp.other.example/mcp",
      null, dependencies,
    ),
    /binding validation failed/u,
  );
  await assert.rejects(
    exchangeAuthorizationCodeWithDependencies(
      "ebt_ac_unknown", authorizationRequest.clientId, authorizationRequest.redirectUri,
      authorizationRequest.resource, verifier, dependencies,
    ),
    /invalid, expired, or already used/u,
  );
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_unknown", authorizationRequest.clientId, authorizationRequest.resource,
      null, dependencies,
    ),
    /invalid, expired, or already used/u,
  );
  assert.equal(revocationAttempted, false);
  assert.equal(activityAttempted, false);
});

const createRefreshDependencies = (
  grantedScopes: ReadonlyArray<string>,
  tokenScopes: Array<ReadonlyArray<string>>,
  updateCount: { value: number },
): OAuthStoreDependencies => {
  let connectionRevoked = false;
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: grantedScopes,
        used: updateCount.value > 0,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: connectionRevoked,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) updateCount.value += 1;
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      connectionRevoked = true;
      return result([{ connection_id: "connection-1" }]);
    }
    if (text.includes("oauth_access_tokens") || text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
      tokenScopes.push(params[2] as ReadonlyArray<string>);
    }
    return result([]);
  };
  return createDependencies(queryFn, { ...emptyTokens(), at: ["ebt_at_rotated"], rt: ["ebt_rt_rotated"] });
};

test("refresh rotation supports down-scope, rejects replay and expansion, and preserves omitted scope", async (): Promise<void> => {
  const narrowedScopes: Array<ReadonlyArray<string>> = [];
  const narrowedUpdates = { value: 0 };
  const narrowedDependencies = createRefreshDependencies(
    ["expenses:read", "expenses:write"], narrowedScopes, narrowedUpdates,
  );
  const narrowed = await exchangeRefreshTokenWithDependencies(
    "ebt_rt_presented", authorizationRequest.clientId, authorizationRequest.resource,
    ["expenses:read"], narrowedDependencies,
  );
  assert.equal(narrowed.scope, "expenses:read");
  assert.deepEqual(narrowedScopes, [["expenses:read"], ["expenses:read"]]);
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_presented", authorizationRequest.clientId, authorizationRequest.resource,
      null, narrowedDependencies,
    ),
    /already used/u,
  );

  const expansionUpdates = { value: 0 };
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_read-only", authorizationRequest.clientId, authorizationRequest.resource,
      ["expenses:read", "expenses:write"],
      createRefreshDependencies(["expenses:read"], [], expansionUpdates),
    ),
    /cannot exceed/u,
  );
  assert.equal(expansionUpdates.value, 0);

  const unchangedScopes: Array<ReadonlyArray<string>> = [];
  const unchanged = await exchangeRefreshTokenWithDependencies(
    "ebt_rt_unchanged", authorizationRequest.clientId, authorizationRequest.resource,
    null,
    createRefreshDependencies(["expenses:read", "expenses:write"], unchangedScopes, { value: 0 }),
  );
  assert.equal(unchanged.scope, "expenses:read expenses:write");
  assert.deepEqual(unchangedScopes, [authorizationRequest.scopes, authorizationRequest.scopes]);
});

test("active owner validation runs outside the transaction before locked refresh revalidation", async (): Promise<void> => {
  const sequence: Array<string> = [];
  let transactionOpen = false;
  let used = false;
  const queryFn: QueryFn = async (text) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      sequence.push(text.includes("FOR UPDATE") ? "locked_read" : "preflight_read");
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) {
      used = true;
      sequence.push("consume");
    }
    if (isOAuthActivityQuery(text)) sequence.push("record_activity");
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens")) sequence.push("insert_access");
    if (text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) sequence.push("insert_refresh");
    return result([]);
  };
  const dependencies = createDependencies(queryFn, {
    ...emptyTokens(),
    at: ["ebt_at_active-owner"],
    rt: ["ebt_rt_active-owner"],
  });
  const activeDependencies: OAuthStoreDependencies = {
    ...dependencies,
    query: async (text, params) => {
      if (isOAuthCleanupQuery(text)) {
        assert.equal(transactionOpen, false);
        sequence.push("cleanup");
        return result([]);
      }
      return queryFn(text, params);
    },
    withTransaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpen = true;
      try {
        return await callback(queryFn);
      } finally {
        transactionOpen = false;
      }
    },
    ownerPolicy: ownerPolicyReading(async (requestedUserId) => {
      assert.equal(requestedUserId, "user-1");
      assert.equal(transactionOpen, false);
      sequence.push("cognito_check");
      return "active";
    }),
  };

  await exchangeRefreshTokenWithDependencies(
    "ebt_rt_active-owner-presented",
    authorizationRequest.clientId,
    authorizationRequest.resource,
    null,
    activeDependencies,
  );

  assert.deepEqual(sequence, [
    "cleanup",
    "preflight_read",
    "cognito_check",
    "locked_read",
    "consume",
    "record_activity",
    "insert_access",
    "insert_refresh",
  ]);
});

test("inactive owners revoke every active OAuth connection and receive generic invalid_grant", async (): Promise<void> => {
  let consumed = false;
  let tokenInserted = false;
  let transactionOpened = false;
  let activityRecorded = false;
  let revokedUserId: string | undefined;
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      assert.match(text, /WHERE user_id = \$1 AND revoked_at IS NULL/u);
      const value = params[0];
      if (typeof value !== "string") throw new Error("Inactive-owner test expected a user ID");
      revokedUserId = value;
      return result([]);
    }
    if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) consumed = true;
    if (isOAuthActivityQuery(text)) activityRecorded = true;
    if (text.startsWith("INSERT INTO auth.oauth_")) tokenInserted = true;
    return result([]);
  };
  const baseDependencies = createDependencies(queryFn, emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    withTransaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(queryFn);
    },
    ownerPolicy: ownerPolicyReading(async () => "inactive"),
  };

  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_inactive-owner",
      authorizationRequest.clientId,
      authorizationRequest.resource,
      null,
      dependencies,
    ),
    (error: unknown) => isOAuthProtocolError(error)
      && error.oauthCode === "invalid_grant"
      && !error.message.includes("inactive"),
  );
  assert.equal(revokedUserId, "user-1");
  assert.equal(transactionOpened, false);
  assert.equal(consumed, false);
  assert.equal(tokenInserted, false);
  assert.equal(activityRecorded, false);
});

test("transient owner validation failure neither consumes the refresh token nor revokes connections", async (): Promise<void> => {
  const transientFailure = new Error("Cognito unavailable after retries");
  let mutationAttempted = false;
  let transactionOpened = false;
  const queryFn: QueryFn = async (text) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE") || text.startsWith("INSERT") || isOAuthActivityQuery(text)) mutationAttempted = true;
    return result([]);
  };
  const baseDependencies = createDependencies(queryFn, emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    withTransaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(queryFn);
    },
    ownerPolicy: ownerPolicyReading(async () => { throw transientFailure; }),
  };

  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_transient-owner",
      authorizationRequest.clientId,
      authorizationRequest.resource,
      null,
      dependencies,
    ),
    (error: unknown) => error === transientFailure,
  );
  assert.equal(transactionOpened, false);
  assert.equal(mutationAttempted, false);
});

test("disablement immediately after an active snapshot is enforced at the next renewal", async (): Promise<void> => {
  const originalToken = "ebt_rt_race-original";
  const storedRefreshTokens = new Map<string, boolean>([[hash(originalToken), false]]);
  const storedAccessTokens = new Set<string>();
  let connectionRevoked = false;
  let ownerActive = true;
  let ownerChecks = 0;
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      const tokenHash = params[0];
      if (typeof tokenHash !== "string") throw new Error("Race test expected a refresh-token hash");
      const used = storedRefreshTokens.get(tokenHash);
      if (used === undefined) return result([]);
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: connectionRevoked,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) {
      const tokenHash = params[0];
      if (typeof tokenHash !== "string") throw new Error("Race test expected a consumed refresh-token hash");
      storedRefreshTokens.set(tokenHash, true);
    }
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens")) {
      const tokenHash = params[0];
      if (typeof tokenHash !== "string") throw new Error("Race test expected an access-token hash");
      storedAccessTokens.add(tokenHash);
    }
    if (text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
      const tokenHash = params[0];
      if (typeof tokenHash !== "string") throw new Error("Race test expected a rotated refresh-token hash");
      storedRefreshTokens.set(tokenHash, false);
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) connectionRevoked = true;
    return result([]);
  };
  const baseDependencies = createDependencies(queryFn, {
    ...emptyTokens(),
    at: ["ebt_at_race-window"],
    rt: ["ebt_rt_race-rotated"],
  });
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    ownerPolicy: ownerPolicyReading(async () => {
      ownerChecks += 1;
      if (ownerChecks === 1) {
        ownerActive = false;
        return "active";
      }
      return ownerActive ? "active" : "inactive";
    }),
  };

  const issuedDuringRace = await exchangeRefreshTokenWithDependencies(
    originalToken,
    authorizationRequest.clientId,
    authorizationRequest.resource,
    null,
    dependencies,
  );
  assert.equal(issuedDuringRace.expiresIn, 3600);
  assert.equal(storedAccessTokens.has(hash(issuedDuringRace.accessToken)), true);
  assert.equal(connectionRevoked, false);

  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      issuedDuringRace.refreshToken,
      authorizationRequest.clientId,
      authorizationRequest.resource,
      null,
      dependencies,
    ),
    /invalid, expired, or already used/u,
  );
  assert.equal(ownerChecks, 2);
  assert.equal(connectionRevoked, true);
  assert.equal(storedAccessTokens.has(hash(issuedDuringRace.accessToken)) && !connectionRevoked, false);
});

test("binding-mismatched replay of a used refresh token revokes its replacement credentials", async (): Promise<void> => {
  const originalToken = "ebt_rt_original";
  let originalUsed = false;
  let connectionRevoked = false;
  let rotatedTokenHash: string | null = null;
  const accessTokenHashes = new Set<string>();
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      const tokenHash = params[0];
      if (tokenHash !== hash(originalToken) && tokenHash !== rotatedTokenHash) return result([]);
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: tokenHash === hash(originalToken) ? originalUsed : false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: connectionRevoked,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) {
      if (params[0] === hash(originalToken)) originalUsed = true;
      return result([]);
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      connectionRevoked = true;
      return result([{ connection_id: "connection-1" }]);
    }
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens")) {
      accessTokenHashes.add(params[0] as string);
      return result([]);
    }
    if (text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
      rotatedTokenHash = params[0] as string;
      return result([]);
    }
    return result([]);
  };
  const dependencies = createDependencies(queryFn, {
    ...emptyTokens(),
    at: ["ebt_at_replacement"],
    rt: ["ebt_rt_replacement"],
  });

  const replacement = await exchangeRefreshTokenWithDependencies(
    originalToken, authorizationRequest.clientId, authorizationRequest.resource,
    null, dependencies,
  );
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      originalToken, "mismatched-client", authorizationRequest.resource,
      null, dependencies,
    ),
    /invalid, expired, or already used/u,
  );

  assert.equal(connectionRevoked, true);
  assert.equal(accessTokenHashes.has(hash(replacement.accessToken)) && !connectionRevoked, false);
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      replacement.refreshToken, authorizationRequest.clientId, authorizationRequest.resource,
      null, dependencies,
    ),
    /invalid, expired, or already used/u,
  );
});

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

const createDeferred = (): Deferred => {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = () => resolve(); });
  return { promise, resolve: resolvePromise };
};

type StoredRefreshToken = Readonly<{
  connectionId: string;
  scopes: ReadonlyArray<string>;
  used: boolean;
}>;

const createConcurrentRefreshStore = (): Readonly<{
  dependencies: OAuthStoreDependencies;
  validatesAccessToken: (token: string) => boolean;
}> => {
  const connectionId = "connection-1";
  const presentedToken = "ebt_rt_concurrent";
  const refreshTokens = new Map<string, StoredRefreshToken>([[
    hash(presentedToken),
    { connectionId, scopes: authorizationRequest.scopes, used: false },
  ]]);
  const accessTokens = new Set<string>();
  const secondTransactionWaiting = createDeferred();
  const firstTransactionCommitted = createDeferred();
  let connectionRevoked = false;
  let transactionCount = 0;

  const withTransaction = async <T>(callback: (queryFn: QueryFn) => Promise<T>): Promise<T> => {
    transactionCount += 1;
    const transactionNumber = transactionCount;
    let consumedTokenHash: string | null = null;
    let revokeConnection = false;
    const pendingAccessTokens: Array<string> = [];
    const pendingRefreshTokens: Array<Readonly<{ tokenHash: string; token: StoredRefreshToken }>> = [];

    const transactionQuery: QueryFn = async (text, params) => {
      if (text.includes("FROM auth.oauth_refresh_tokens")) {
        assert.match(text, /FOR UPDATE OF ort, oc/u);
        const tokenHash = params[0];
        if (typeof tokenHash !== "string") throw new Error("Concurrent refresh test expected a token hash");
        if (transactionNumber === 1) {
          await secondTransactionWaiting.promise;
        } else if (transactionNumber === 2) {
          secondTransactionWaiting.resolve();
          await firstTransactionCommitted.promise;
        }
        const token = refreshTokens.get(tokenHash);
        if (token === undefined) return result([]);
        return result([{
          connection_id: token.connectionId,
          user_id: "user-1",
          scopes: token.scopes,
          used: token.used,
          unexpired: true,
          client_id: authorizationRequest.clientId,
          resource: authorizationRequest.resource,
          revoked: connectionRevoked,
        }]);
      }
      if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) {
        const tokenHash = params[0];
        if (typeof tokenHash !== "string") throw new Error("Concurrent refresh test expected a consumed token hash");
        consumedTokenHash = tokenHash;
        return result([]);
      }
      if (text.startsWith("INSERT INTO auth.oauth_access_tokens")) {
        const tokenHash = params[0];
        if (typeof tokenHash !== "string") throw new Error("Concurrent refresh test expected an access token hash");
        pendingAccessTokens.push(tokenHash);
        return result([]);
      }
      if (text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
        const tokenHash = params[0];
        const storedConnectionId = params[1];
        const scopes = params[2];
        if (
          typeof tokenHash !== "string"
          || typeof storedConnectionId !== "string"
          || !Array.isArray(scopes)
          || scopes.some((scope: unknown) => typeof scope !== "string")
        ) {
          throw new Error("Concurrent refresh test received an invalid rotated refresh token");
        }
        pendingRefreshTokens.push({
          tokenHash,
          token: { connectionId: storedConnectionId, scopes: scopes as ReadonlyArray<string>, used: false },
        });
        return result([]);
      }
      if (isOAuthActivityQuery(text)) return result([]);
      if (text.startsWith("UPDATE auth.oauth_connections")) {
        assert.equal(params[0], connectionId);
        revokeConnection = true;
        return result([{ connection_id: connectionId }]);
      }
      throw new Error(`Concurrent refresh test received an unexpected query: ${text}`);
    };

    try {
      const value = await callback(transactionQuery);
      if (consumedTokenHash !== null) {
        const token = refreshTokens.get(consumedTokenHash);
        if (token === undefined) throw new Error("Concurrent refresh test could not commit token consumption");
        refreshTokens.set(consumedTokenHash, { ...token, used: true });
      }
      for (const tokenHash of pendingAccessTokens) accessTokens.add(tokenHash);
      for (const pending of pendingRefreshTokens) refreshTokens.set(pending.tokenHash, pending.token);
      if (revokeConnection) connectionRevoked = true;
      if (transactionNumber === 1) firstTransactionCommitted.resolve();
      return value;
    } catch (error) {
      if (transactionNumber === 1) firstTransactionCommitted.resolve();
      throw error;
    }
  };

  const tokens = {
    ...emptyTokens(),
    at: ["ebt_at_concurrent-replacement"],
    rt: ["ebt_rt_concurrent-replacement"],
  };
  const queryFn: QueryFn = async (text, params) => {
    if (!text.includes("FROM auth.oauth_refresh_tokens")) {
      throw new Error(`Concurrent refresh preflight received an unexpected query: ${text}`);
    }
    assert.doesNotMatch(text, /FOR UPDATE/u);
    const tokenHash = params[0];
    if (typeof tokenHash !== "string") throw new Error("Concurrent refresh preflight expected a token hash");
    const token = refreshTokens.get(tokenHash);
    if (token === undefined) return result([]);
    return result([{
      connection_id: token.connectionId,
      user_id: "user-1",
      scopes: token.scopes,
      used: token.used,
      unexpired: true,
      client_id: authorizationRequest.clientId,
      resource: authorizationRequest.resource,
      revoked: connectionRevoked,
    }]);
  };
  const dependencies = { ...createDependencies(queryFn, tokens), withTransaction };
  return {
    dependencies,
    validatesAccessToken: (token) => accessTokens.has(hash(token)) && !connectionRevoked,
  };
};

test("concurrent refresh replay revokes the family and its replacement credentials", async (): Promise<void> => {
  const store = createConcurrentRefreshStore();
  const exchanges = await Promise.allSettled([
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_concurrent", authorizationRequest.clientId, authorizationRequest.resource,
      null, store.dependencies,
    ),
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_concurrent", authorizationRequest.clientId, authorizationRequest.resource,
      null, store.dependencies,
    ),
  ]);

  assert.equal(exchanges[0]?.status, "fulfilled");
  assert.equal(exchanges[1]?.status, "rejected");
  const winner = exchanges[0];
  if (winner?.status !== "fulfilled") throw new Error("Concurrent refresh test expected one successful rotation");
  assert.equal(store.validatesAccessToken(winner.value.accessToken), false);
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      winner.value.refreshToken, authorizationRequest.clientId, authorizationRequest.resource,
      null, store.dependencies,
    ),
    /invalid, expired, or already used/u,
  );
});

test("an expired unused refresh token is rejected without revoking its connection", async (): Promise<void> => {
  let revocationAttempted = false;
  const queryFn: QueryFn = async (text) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: false,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) revocationAttempted = true;
    return result([]);
  };

  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_expired", authorizationRequest.clientId, authorizationRequest.resource,
      null, createDependencies(queryFn, emptyTokens()),
    ),
    /invalid, expired, or already used/u,
  );
  assert.equal(revocationAttempted, false);
});

test("replaying an expired used refresh token revokes its active family", async (): Promise<void> => {
  let connectionRevoked = false;
  const queryFn: QueryFn = async (text) => {
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: true,
        unexpired: false,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      connectionRevoked = true;
      return result([{ connection_id: "connection-1" }]);
    }
    return result([]);
  };

  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_used-and-expired", authorizationRequest.clientId, authorizationRequest.resource,
      null, createDependencies(queryFn, emptyTokens()),
    ),
    /invalid, expired, or already used/u,
  );
  assert.equal(connectionRevoked, true);
});

test("revoked connections cannot exchange authorization codes or refresh tokens", async (): Promise<void> => {
  let codeLoaded = false;
  let refreshTokenLoaded = false;
  let codeConsumed = false;
  let accessTokenInserted = false;
  let refreshTokenInserted = false;
  const revokedConnection: QueryFn = async (text) => {
    if (text.includes("FROM auth.oauth_authorization_codes")) {
      codeLoaded = true;
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        redirect_uri: authorizationRequest.redirectUri,
        code_challenge: challenge,
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: true,
      }]);
    }
    if (text.includes("FROM auth.oauth_refresh_tokens")) {
      refreshTokenLoaded = true;
      return result([{
        connection_id: "connection-1",
        user_id: "user-1",
        scopes: authorizationRequest.scopes,
        used: false,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: true,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_authorization_codes")) codeConsumed = true;
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens")) accessTokenInserted = true;
    if (text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) refreshTokenInserted = true;
    return result([]);
  };
  const dependencies = createDependencies(revokedConnection, emptyTokens());
  await assert.rejects(
    exchangeAuthorizationCodeWithDependencies(
      "ebt_ac_revoked", authorizationRequest.clientId, authorizationRequest.redirectUri,
      authorizationRequest.resource, verifier, dependencies,
    ),
    /invalid, expired, or already used/u,
  );
  await assert.rejects(
    exchangeRefreshTokenWithDependencies(
      "ebt_rt_revoked", authorizationRequest.clientId, authorizationRequest.resource,
      null, dependencies,
    ),
    /invalid, expired, or already used/u,
  );
  assert.equal(codeLoaded, true);
  assert.equal(refreshTokenLoaded, true);
  assert.equal(codeConsumed, false);
  assert.equal(accessTokenInserted, false);
  assert.equal(refreshTokenInserted, false);
});

const PROXY_USER_ID = "proxy-user-1";
const PROXY_USER_EMAIL = "proxy-user@example.com";
const PROXY_CONNECTION_ID = "connection-proxy-1";

type MirroredUser = { email: string; status: string; enabled: boolean };

type ProxyDatabase = Readonly<{
  queryFn: QueryFn;
  users: Map<string, MirroredUser>;
  refreshTokenHashes: Array<string>;
  seedRefreshToken: (token: string) => void;
  revokedConnectionCount: () => number;
}>;

/**
 * An in-memory stand-in for the auth-service database in proxy_jwt mode.
 *
 * `auth.mirror_authenticated_user` is modelled exactly as migration 0079
 * writes it: a first sighting inserts the passed status, an existing row keeps
 * its account state. `auth.sync_authenticated_user` is a hard failure here,
 * because a proxy consent round-trip must never take the state-raising path.
 */
const createProxyDatabase = (seededUser: MirroredUser | null): ProxyDatabase => {
  const users = new Map<string, MirroredUser>();
  if (seededUser !== null) users.set(PROXY_USER_ID, { ...seededUser });
  const codes = new Map<string, { used: boolean; redirectUri: string; codeChallenge: string; scopes: ReadonlyArray<string> }>();
  const refreshTokens = new Map<string, { used: boolean; scopes: ReadonlyArray<string> }>();
  const refreshTokenHashes: Array<string> = [];
  let revokedConnections = 0;

  const queryFn: QueryFn = async (text, params) => {
    if (isOAuthCleanupQuery(text) || isOAuthActivityQuery(text)) return result([]);
    if (text.startsWith("SELECT account_status, account_enabled")) {
      const user = users.get(String(params[0]));
      return result(user === undefined
        ? []
        : [{ account_status: user.status, account_enabled: user.enabled }]);
    }
    if (text.startsWith("SELECT auth.mirror_authenticated_user")) {
      const [userId, email, initialStatus] = params as ReadonlyArray<string>;
      const existing = users.get(userId);
      users.set(userId, existing === undefined
        ? { email, status: initialStatus, enabled: true }
        : { ...existing, email });
      return result([]);
    }
    if (text.startsWith("SELECT auth.sync_authenticated_user")) {
      throw new Error("proxy_jwt consent must not raise the mirrored account state");
    }
    if (text.startsWith("INSERT INTO auth.oauth_connections")) {
      return result([{ connection_id: PROXY_CONNECTION_ID }]);
    }
    if (text.startsWith("INSERT INTO auth.oauth_authorization_codes")) {
      const [codeHash, , redirectUri, codeChallenge, scopes] = params as ReadonlyArray<unknown>;
      codes.set(String(codeHash), {
        used: false,
        redirectUri: String(redirectUri),
        codeChallenge: String(codeChallenge),
        scopes: scopes as ReadonlyArray<string>,
      });
      return result([]);
    }
    if (text.startsWith("SELECT oac.connection_id")) {
      const code = codes.get(String(params[0]));
      if (code === undefined) return result([]);
      return result([{
        connection_id: PROXY_CONNECTION_ID,
        user_id: PROXY_USER_ID,
        redirect_uri: code.redirectUri,
        code_challenge: code.codeChallenge,
        scopes: [...code.scopes],
        used: code.used,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_authorization_codes")) {
      const code = codes.get(String(params[0]));
      if (code !== undefined) code.used = true;
      return result([]);
    }
    if (text.startsWith("SELECT ort.connection_id")) {
      const refreshToken = refreshTokens.get(String(params[0]));
      if (refreshToken === undefined) return result([]);
      return result([{
        connection_id: PROXY_CONNECTION_ID,
        user_id: PROXY_USER_ID,
        scopes: [...refreshToken.scopes],
        used: refreshToken.used,
        unexpired: true,
        client_id: authorizationRequest.clientId,
        resource: authorizationRequest.resource,
        revoked: false,
      }]);
    }
    if (text.startsWith("UPDATE auth.oauth_refresh_tokens")) {
      const refreshToken = refreshTokens.get(String(params[0]));
      if (refreshToken !== undefined) refreshToken.used = true;
      return result([]);
    }
    if (text.startsWith("INSERT INTO auth.oauth_refresh_tokens")) {
      const [tokenHash, , scopes] = params as ReadonlyArray<unknown>;
      refreshTokens.set(String(tokenHash), { used: false, scopes: scopes as ReadonlyArray<string> });
      refreshTokenHashes.push(String(tokenHash));
      return result([]);
    }
    if (text.startsWith("INSERT INTO auth.oauth_access_tokens")) return result([]);
    if (text.startsWith("UPDATE auth.oauth_connections")) {
      revokedConnections += 1;
      return result([{ connection_id: PROXY_CONNECTION_ID }]);
    }
    throw new Error(`Unexpected proxy_jwt query: ${text}`);
  };

  return {
    queryFn,
    users,
    refreshTokenHashes,
    seedRefreshToken: (token: string): void => {
      refreshTokens.set(hash(token), { used: false, scopes: authorizationRequest.scopes });
    },
    revokedConnectionCount: (): number => revokedConnections,
  };
};

const createProxyDependencies = (
  database: ProxyDatabase,
  tokens: Readonly<Record<"cl" | "ac" | "at" | "rt", ReadonlyArray<string>>>,
): OAuthStoreDependencies => ({
  ...createDependencies(database.queryFn, tokens),
  query: database.queryFn,
  ownerPolicy: getOAuthOwnerPolicy("proxy_jwt"),
});

/**
 * Run with every Cognito variable removed, so any call that still reaches the
 * user pool throws instead of quietly passing.
 */
const withoutCognitoEnvironment = async (operation: () => Promise<void>): Promise<void> => {
  const cognitoKeys = ["COGNITO_USER_POOL_ID", "COGNITO_REGION", "COGNITO_CLIENT_ID"] as const;
  const previous = cognitoKeys.map((key): readonly [string, string | undefined] => [key, process.env[key]]);
  for (const key of cognitoKeys) delete process.env[key];
  try {
    await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("proxy_jwt issues and exchanges a code against the identity mirror, with no Cognito reachable", async (): Promise<void> => {
  await withoutCognitoEnvironment(async (): Promise<void> => {
    const database = createProxyDatabase({ email: PROXY_USER_EMAIL, status: "PROXY", enabled: true });
    const dependencies = createProxyDependencies(database, {
      ...emptyTokens(),
      ac: ["ebt_ac_proxy-issued"],
      at: ["ebt_at_proxy-issued"],
      rt: ["ebt_rt_proxy-issued"],
    });

    const code = await issueAuthorizationCodeWithDependencies(
      authorizationRequest,
      PROXY_USER_ID,
      PROXY_USER_EMAIL,
      dependencies,
    );
    assert.equal(code, "ebt_ac_proxy-issued");

    const tokens = await exchangeAuthorizationCodeWithDependencies(
      code,
      authorizationRequest.clientId,
      authorizationRequest.redirectUri,
      authorizationRequest.resource,
      verifier,
      dependencies,
    );
    assert.equal(tokens.accessToken, "ebt_at_proxy-issued");
    assert.equal(tokens.refreshToken, "ebt_rt_proxy-issued");
    assert.equal(tokens.expiresIn, 3600);
    assert.equal(tokens.scope, "expenses:read expenses:write");
    assert.equal(database.revokedConnectionCount(), 0);

    const refreshed = await exchangeRefreshTokenWithDependencies(
      tokens.refreshToken,
      authorizationRequest.clientId,
      authorizationRequest.resource,
      null,
      { ...dependencies, createOpaqueToken: (prefix) => `ebt_${prefix}_proxy-refreshed` },
    );
    assert.equal(refreshed.accessToken, "ebt_at_proxy-refreshed");
    assert.deepEqual(database.users.get(PROXY_USER_ID), {
      email: PROXY_USER_EMAIL,
      status: "PROXY",
      enabled: true,
    });
  });
});

test("proxy_jwt consent mirrors a first-seen edge identity as PROXY without raising later state", async (): Promise<void> => {
  await withoutCognitoEnvironment(async (): Promise<void> => {
    const database = createProxyDatabase(null);
    const dependencies = createProxyDependencies(database, {
      ...emptyTokens(),
      ac: ["ebt_ac_proxy-first", "ebt_ac_proxy-second"],
    });

    await issueAuthorizationCodeWithDependencies(
      authorizationRequest,
      PROXY_USER_ID,
      PROXY_USER_EMAIL,
      dependencies,
    );
    assert.deepEqual(database.users.get(PROXY_USER_ID), {
      email: PROXY_USER_EMAIL,
      status: "PROXY",
      enabled: true,
    });

    // The owner is disabled after the first consent; a second round-trip must
    // be refused instead of restoring the account through the mirror write.
    const owner = database.users.get(PROXY_USER_ID);
    assert.notEqual(owner, undefined);
    if (owner !== undefined) owner.enabled = false;

    await assert.rejects(
      issueAuthorizationCodeWithDependencies(
        authorizationRequest,
        PROXY_USER_ID,
        PROXY_USER_EMAIL,
        dependencies,
      ),
      (error: unknown) => isOAuthProtocolError(error) && error.oauthCode === "access_denied",
    );
    assert.equal(database.users.get(PROXY_USER_ID)?.enabled, false);
    assert.equal(database.revokedConnectionCount(), 1);
  });
});

test("proxy_jwt refuses an owner the mirror reports as not active, at issuance and at refresh", async (): Promise<void> => {
  await withoutCognitoEnvironment(async (): Promise<void> => {
    const inactiveOwners: ReadonlyArray<MirroredUser> = [
      { email: PROXY_USER_EMAIL, status: "PROXY", enabled: false },
      { email: PROXY_USER_EMAIL, status: "ARCHIVED", enabled: true },
    ];
    for (const owner of inactiveOwners) {
      const database = createProxyDatabase(owner);
      const dependencies = createProxyDependencies(database, {
        ...emptyTokens(),
        ac: ["ebt_ac_proxy-refused"],
      });

      await assert.rejects(
        issueAuthorizationCodeWithDependencies(
          authorizationRequest,
          PROXY_USER_ID,
          PROXY_USER_EMAIL,
          dependencies,
        ),
        (error: unknown) => isOAuthProtocolError(error)
          && error.oauthCode === "access_denied"
          && error.status === 400,
      );

      database.seedRefreshToken("ebt_rt_proxy-existing");
      await assert.rejects(
        exchangeRefreshTokenWithDependencies(
          "ebt_rt_proxy-existing",
          authorizationRequest.clientId,
          authorizationRequest.resource,
          null,
          dependencies,
        ),
        (error: unknown) => isOAuthProtocolError(error) && error.oauthCode === "invalid_grant",
      );
      assert.equal(database.refreshTokenHashes.length, 0);
      assert.equal(database.revokedConnectionCount(), 2);
    }
  });
});

test("the owner account-state migration reads the mirror and never raises it", (): void => {
  const ownerStateMigration = readFileSync(
    fileURLToPath(new URL("../../../../../db/migrations/0079_oauth_owner_account_state.sql", import.meta.url)),
    "utf8",
  );
  assert.match(
    ownerStateMigration,
    /CREATE FUNCTION auth\.get_oauth_owner_account_state\(p_user_id TEXT\)\s+RETURNS TABLE\(account_status TEXT, account_enabled BOOLEAN\)/u,
  );
  assert.match(
    ownerStateMigration,
    /SELECT account\.cognito_status, account\.cognito_enabled\s+FROM public\.users AS account\s+WHERE account\.user_id = p_user_id/u,
  );
  const mirrorFunctionSql = readMigrationSection(
    ownerStateMigration,
    "CREATE FUNCTION auth.mirror_authenticated_user(",
  );
  assert.match(
    mirrorFunctionSql,
    /ON CONFLICT \(user_id\) DO UPDATE\s+SET email = EXCLUDED\.email,\s+last_seen_at = now\(\),\s+updated_at = now\(\);/u,
  );
  const conflictUpdateSql = mirrorFunctionSql.slice(mirrorFunctionSql.indexOf("ON CONFLICT"));
  assert.doesNotMatch(conflictUpdateSql, /cognito_status|cognito_enabled|email_verified/u);
  assert.doesNotMatch(ownerStateMigration, /CREATE OR REPLACE FUNCTION auth\.sync_authenticated_user/u);
  assert.match(ownerStateMigration, /SECURITY DEFINER/u);
  assert.match(ownerStateMigration, /REVOKE ALL ON FUNCTION auth\.get_oauth_owner_account_state\(TEXT\) FROM PUBLIC/u);
  assert.match(ownerStateMigration, /GRANT EXECUTE ON FUNCTION auth\.get_oauth_owner_account_state\(TEXT\) TO auth_service/u);
  assert.match(ownerStateMigration, /REVOKE ALL ON FUNCTION auth\.mirror_authenticated_user\(TEXT, TEXT, TEXT\) FROM PUBLIC/u);
  assert.match(ownerStateMigration, /GRANT EXECUTE ON FUNCTION auth\.mirror_authenticated_user\(TEXT, TEXT, TEXT\) TO auth_service/u);
});
