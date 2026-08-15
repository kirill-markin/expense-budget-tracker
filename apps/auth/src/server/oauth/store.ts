import { query, withTransaction, type QueryFn } from "../db.js";
import {
  getCognitoOAuthOwnerStatus,
  type CognitoOAuthOwnerStatus,
} from "../cognitoUserStatus.js";
import {
  createOpaqueToken,
  hashOpaqueToken,
  narrowScopes,
  oauthError,
  verifyCodeVerifier,
  type AuthorizationRequest,
  type OAuthClient,
} from "./core.js";

type Row = Readonly<Record<string, unknown>>;
type TransactionRunner = <T>(callback: (queryFn: QueryFn) => Promise<T>) => Promise<T>;

export type OAuthStoreDependencies = Readonly<{
  query: QueryFn;
  withTransaction: TransactionRunner;
  createOpaqueToken: (prefix: "cl" | "ac" | "at" | "rt") => string;
  getCognitoOAuthOwnerStatus: (userId: string) => Promise<CognitoOAuthOwnerStatus>;
}>;

const defaultDependencies: OAuthStoreDependencies = {
  query,
  withTransaction,
  createOpaqueToken,
  getCognitoOAuthOwnerStatus,
};

export type OAuthTokenResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresIn: 3600;
  scope: string;
}>;

const cleanupExpiredOAuthState = async (
  queryFn: QueryFn,
): Promise<void> => {
  await queryFn("SELECT auth.cleanup_expired_oauth_transient_state()", []);
};

const readRow = (value: unknown, operation: string): Row => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation}: database returned an invalid row`);
  }
  return value as Row;
};

const readString = (row: Row, key: string, operation: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${operation}: database column ${key} must be a non-empty string`);
  }
  return value;
};

const readScopes = (row: Row, operation: string): ReadonlyArray<string> => {
  const value = row["scopes"];
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
    throw new Error(`${operation}: database column scopes must be a string array`);
  }
  return value as ReadonlyArray<string>;
};

const readBoolean = (row: Row, key: string, operation: string): boolean => {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new Error(`${operation}: database column ${key} must be a boolean`);
  }
  return value;
};

type RefreshTokenRecord = Readonly<{
  connectionId: string;
  userId: string;
  scopes: ReadonlyArray<string>;
  used: boolean;
  unexpired: boolean;
  clientId: string;
  resource: string;
  revoked: boolean;
}>;

type AuthorizationCodeRecord = Readonly<{
  connectionId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: ReadonlyArray<string>;
  used: boolean;
  unexpired: boolean;
  clientId: string;
  resource: string;
  revoked: boolean;
}>;

const readAuthorizationCodeRecord = (value: unknown): AuthorizationCodeRecord => {
  const operation = "exchangeAuthorizationCode";
  const row = readRow(value, operation);
  return {
    connectionId: readString(row, "connection_id", operation),
    userId: readString(row, "user_id", operation),
    redirectUri: readString(row, "redirect_uri", operation),
    codeChallenge: readString(row, "code_challenge", operation),
    scopes: readScopes(row, operation),
    used: readBoolean(row, "used", operation),
    unexpired: readBoolean(row, "unexpired", operation),
    clientId: readString(row, "client_id", operation),
    resource: readString(row, "resource", operation),
    revoked: readBoolean(row, "revoked", operation),
  };
};

const readRefreshTokenRecord = (value: unknown): RefreshTokenRecord => {
  const operation = "exchangeRefreshToken";
  const row = readRow(value, operation);
  return {
    connectionId: readString(row, "connection_id", operation),
    userId: readString(row, "user_id", operation),
    scopes: readScopes(row, operation),
    used: readBoolean(row, "used", operation),
    unexpired: readBoolean(row, "unexpired", operation),
    clientId: readString(row, "client_id", operation),
    resource: readString(row, "resource", operation),
    revoked: readBoolean(row, "revoked", operation),
  };
};

export const registerOAuthClientWithDependencies = async (
  clientName: string,
  redirectUris: ReadonlyArray<string>,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthClient> => {
  const clientId = dependencies.createOpaqueToken("cl");
  await dependencies.query(
    `INSERT INTO auth.oauth_clients (client_id, client_name, redirect_uris)
     VALUES ($1, $2, $3)`,
    [clientId, clientName, redirectUris],
  );
  return { clientId, clientName, redirectUris };
};

export const registerOAuthClient = (
  clientName: string,
  redirectUris: ReadonlyArray<string>,
): Promise<OAuthClient> => registerOAuthClientWithDependencies(clientName, redirectUris, defaultDependencies);

export const getOAuthClientWithDependencies = async (
  clientId: string,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthClient | null> => {
  const result = await dependencies.query(
    `SELECT client_id, client_name, redirect_uris
     FROM auth.oauth_clients
     WHERE client_id = $1`,
    [clientId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw new Error(`getOAuthClient: expected at most 1 row, got ${result.rows.length}`);
  const row = readRow(result.rows[0], "getOAuthClient");
  const redirectUris = row["redirect_uris"];
  if (!Array.isArray(redirectUris) || redirectUris.some((uri) => typeof uri !== "string")) {
    throw new Error("getOAuthClient: database column redirect_uris must be a string array");
  }
  return {
    clientId: readString(row, "client_id", "getOAuthClient"),
    clientName: readString(row, "client_name", "getOAuthClient"),
    redirectUris: redirectUris as ReadonlyArray<string>,
  };
};

export const getOAuthClient = (clientId: string): Promise<OAuthClient | null> =>
  getOAuthClientWithDependencies(clientId, defaultDependencies);

const revokeActiveConnectionsForUser = async (
  userId: string,
  dependencies: OAuthStoreDependencies,
): Promise<void> => {
  await dependencies.query(
    `UPDATE auth.oauth_connections
     SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
};

export const issueAuthorizationCodeWithDependencies = async (
  request: AuthorizationRequest,
  userId: string,
  email: string,
  dependencies: OAuthStoreDependencies,
): Promise<string> => {
  await cleanupExpiredOAuthState(dependencies.query);
  const ownerStatus = await dependencies.getCognitoOAuthOwnerStatus(userId);
  if (ownerStatus === "inactive") {
    await revokeActiveConnectionsForUser(userId, dependencies);
    throw oauthError("access_denied", "User is not eligible for OAuth authorization", 400);
  }
  const code = dependencies.createOpaqueToken("ac");
  const codeHash = hashOpaqueToken(code);
  return dependencies.withTransaction(async (queryFn: QueryFn) => {
    await queryFn("SELECT auth.sync_authenticated_user($1, $2)", [userId, email]);
    const connectionResult = await queryFn(
      `INSERT INTO auth.oauth_connections (client_id, user_id, resource)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, user_id, resource) WHERE revoked_at IS NULL DO UPDATE
         SET updated_at = now()
       RETURNING connection_id`,
      [request.clientId, userId, request.resource],
    );
    if (connectionResult.rows.length !== 1) {
      throw new Error(`issueAuthorizationCode: expected 1 connection row, got ${connectionResult.rows.length}`);
    }
    const connectionId = readString(readRow(connectionResult.rows[0], "issueAuthorizationCode"), "connection_id", "issueAuthorizationCode");
    await queryFn(
      `INSERT INTO auth.oauth_authorization_codes
         (code_hash, connection_id, redirect_uri, code_challenge, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + INTERVAL '5 minutes')`,
      [codeHash, connectionId, request.redirectUri, request.codeChallenge, request.scopes],
    );
    return code;
  });
};

export const issueAuthorizationCode = (
  request: AuthorizationRequest,
  userId: string,
  email: string,
): Promise<string> => issueAuthorizationCodeWithDependencies(request, userId, email, defaultDependencies);

const insertTokenPair = async (
  queryFn: QueryFn,
  connectionId: string,
  scopes: ReadonlyArray<string>,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthTokenResult> => {
  const accessToken = dependencies.createOpaqueToken("at");
  const refreshToken = dependencies.createOpaqueToken("rt");
  await queryFn("SELECT auth.record_oauth_connection_activity($1)", [connectionId]);
  await queryFn(
    `INSERT INTO auth.oauth_access_tokens (token_hash, connection_id, scopes, expires_at)
     VALUES ($1, $2, $3, now() + INTERVAL '1 hour')`,
    [hashOpaqueToken(accessToken), connectionId, scopes],
  );
  await queryFn(
    `INSERT INTO auth.oauth_refresh_tokens (token_hash, connection_id, scopes, expires_at)
     VALUES ($1, $2, $3, now() + INTERVAL '30 days')`,
    [hashOpaqueToken(refreshToken), connectionId, scopes],
  );
  return { accessToken, refreshToken, expiresIn: 3600, scope: scopes.join(" ") };
};

const revokeActiveConnection = async (
  queryFn: QueryFn,
  connectionId: string,
  operation: string,
): Promise<void> => {
  const result = await queryFn(
    `UPDATE auth.oauth_connections
     SET revoked_at = now()
     WHERE connection_id = $1 AND revoked_at IS NULL
     RETURNING connection_id`,
    [connectionId],
  );
  if (result.rows.length !== 1) {
    throw new Error(`${operation}: expected 1 revoked connection row, got ${result.rows.length}`);
  }
};

const invalidAuthorizationCodeGrant = (): ReturnType<typeof oauthError> =>
  oauthError("invalid_grant", "Authorization code is invalid, expired, or already used", 400);

const AUTHORIZATION_CODE_SELECT = `SELECT oac.connection_id, oc.user_id,
       oac.redirect_uri, oac.code_challenge, oac.scopes,
       oac.used_at IS NOT NULL AS used,
       oac.expires_at > now() AS unexpired,
       oc.client_id, oc.resource,
       oc.revoked_at IS NOT NULL AS revoked
FROM auth.oauth_authorization_codes oac
JOIN auth.oauth_connections oc ON oc.connection_id = oac.connection_id
WHERE oac.code_hash = $1`;

const readAuthorizationCodeBeforeOwnerCheck = async (
  codeHash: string,
  dependencies: OAuthStoreDependencies,
): Promise<AuthorizationCodeRecord> => {
  const result = await dependencies.query(AUTHORIZATION_CODE_SELECT, [codeHash]);
  if (result.rows.length !== 1) throw invalidAuthorizationCodeGrant();
  return readAuthorizationCodeRecord(result.rows[0]);
};

const lockAuthorizationCodeForExchange = async (
  queryFn: QueryFn,
  codeHash: string,
): Promise<AuthorizationCodeRecord> => {
  const result = await queryFn(
    `${AUTHORIZATION_CODE_SELECT}
FOR UPDATE OF oac, oc`,
    [codeHash],
  );
  if (result.rows.length !== 1) throw invalidAuthorizationCodeGrant();
  return readAuthorizationCodeRecord(result.rows[0]);
};

const validateAuthorizationCodeBinding = (
  record: AuthorizationCodeRecord,
  clientId: string,
  redirectUri: string,
  resource: string,
  codeVerifier: string,
): void => {
  if (
    record.clientId !== clientId
    || record.redirectUri !== redirectUri
    || record.resource !== resource
    || !verifyCodeVerifier(codeVerifier, record.codeChallenge)
  ) {
    throw oauthError("invalid_grant", "Authorization code binding validation failed", 400);
  }
};

const rejectAuthorizationCodeReplay = async (
  codeHash: string,
  dependencies: OAuthStoreDependencies,
): Promise<never> => {
  await dependencies.withTransaction(async (queryFn: QueryFn): Promise<void> => {
    const record = await lockAuthorizationCodeForExchange(queryFn, codeHash);
    if (!record.used) throw invalidAuthorizationCodeGrant();
    if (!record.revoked) {
      await revokeActiveConnection(queryFn, record.connectionId, "exchangeAuthorizationCode");
    }
  });
  throw invalidAuthorizationCodeGrant();
};

export const exchangeAuthorizationCodeWithDependencies = async (
  code: string,
  clientId: string,
  redirectUri: string,
  resource: string,
  codeVerifier: string,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthTokenResult> => {
  await cleanupExpiredOAuthState(dependencies.query);
  const codeHash = hashOpaqueToken(code);
  const record = await readAuthorizationCodeBeforeOwnerCheck(codeHash, dependencies);
  if (record.used) return rejectAuthorizationCodeReplay(codeHash, dependencies);
  if (record.revoked || !record.unexpired) throw invalidAuthorizationCodeGrant();
  validateAuthorizationCodeBinding(record, clientId, redirectUri, resource, codeVerifier);

  const ownerStatus = await dependencies.getCognitoOAuthOwnerStatus(record.userId);
  if (ownerStatus === "inactive") {
    await revokeActiveConnectionsForUser(record.userId, dependencies);
    throw invalidAuthorizationCodeGrant();
  }

  // Cognito eligibility is a point-in-time snapshot. The locked read below
  // revalidates all authorization-code state without holding a row lock over AWS retries.
  const exchangeResult = await dependencies.withTransaction(async (queryFn: QueryFn): Promise<OAuthTokenResult | null> => {
    const lockedRecord = await lockAuthorizationCodeForExchange(queryFn, codeHash);
    if (lockedRecord.used) {
      if (!lockedRecord.revoked) {
        await revokeActiveConnection(queryFn, lockedRecord.connectionId, "exchangeAuthorizationCode");
      }
      return null;
    }
    if (lockedRecord.revoked || lockedRecord.userId !== record.userId || !lockedRecord.unexpired) {
      throw invalidAuthorizationCodeGrant();
    }
    validateAuthorizationCodeBinding(lockedRecord, clientId, redirectUri, resource, codeVerifier);
    await queryFn("UPDATE auth.oauth_authorization_codes SET used_at = now() WHERE code_hash = $1", [codeHash]);
    return insertTokenPair(queryFn, lockedRecord.connectionId, lockedRecord.scopes, dependencies);
  });
  if (exchangeResult === null) throw invalidAuthorizationCodeGrant();
  return exchangeResult;
};

export const exchangeAuthorizationCode = (
  code: string,
  clientId: string,
  redirectUri: string,
  resource: string,
  codeVerifier: string,
): Promise<OAuthTokenResult> => exchangeAuthorizationCodeWithDependencies(
  code, clientId, redirectUri, resource, codeVerifier, defaultDependencies,
);

const invalidRefreshGrant = (): ReturnType<typeof oauthError> =>
  oauthError("invalid_grant", "Refresh token is invalid, expired, or already used", 400);

const REFRESH_TOKEN_SELECT = `SELECT ort.connection_id, oc.user_id, ort.scopes,
       ort.used_at IS NOT NULL AS used,
       ort.expires_at > now() AS unexpired,
       oc.client_id, oc.resource,
       oc.revoked_at IS NOT NULL AS revoked
FROM auth.oauth_refresh_tokens ort
JOIN auth.oauth_connections oc ON oc.connection_id = ort.connection_id
WHERE ort.token_hash = $1`;

const readRefreshTokenBeforeOwnerCheck = async (
  tokenHash: string,
  dependencies: OAuthStoreDependencies,
): Promise<RefreshTokenRecord> => {
  const result = await dependencies.query(REFRESH_TOKEN_SELECT, [tokenHash]);
  if (result.rows.length !== 1) throw invalidRefreshGrant();
  return readRefreshTokenRecord(result.rows[0]);
};

const lockRefreshTokenForRotation = async (
  queryFn: QueryFn,
  tokenHash: string,
): Promise<RefreshTokenRecord> => {
  const result = await queryFn(
    `${REFRESH_TOKEN_SELECT}
FOR UPDATE OF ort, oc`,
    [tokenHash],
  );
  if (result.rows.length !== 1) throw invalidRefreshGrant();
  return readRefreshTokenRecord(result.rows[0]);
};

const validateRefreshTokenBinding = (
  record: RefreshTokenRecord,
  clientId: string,
  resource: string,
): void => {
  if (record.clientId !== clientId || record.resource !== resource) {
    throw oauthError("invalid_grant", "Refresh token binding validation failed", 400);
  }
};

const rejectRefreshTokenReplay = async (
  tokenHash: string,
  dependencies: OAuthStoreDependencies,
): Promise<never> => {
  await dependencies.withTransaction(async (queryFn: QueryFn): Promise<void> => {
    const record = await lockRefreshTokenForRotation(queryFn, tokenHash);
    if (!record.used) throw invalidRefreshGrant();
    if (!record.revoked) {
      await revokeActiveConnection(queryFn, record.connectionId, "exchangeRefreshToken");
    }
  });
  throw invalidRefreshGrant();
};

const rotateRefreshToken = async (
  tokenHash: string,
  expectedUserId: string,
  clientId: string,
  resource: string,
  requestedScopes: ReadonlyArray<string> | null,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthTokenResult | null> => dependencies.withTransaction(
  async (queryFn: QueryFn): Promise<OAuthTokenResult | null> => {
    const record = await lockRefreshTokenForRotation(queryFn, tokenHash);
    if (record.used) {
      if (!record.revoked) {
        await revokeActiveConnection(queryFn, record.connectionId, "exchangeRefreshToken");
      }
      return null;
    }
    if (record.revoked || record.userId !== expectedUserId) throw invalidRefreshGrant();
    validateRefreshTokenBinding(record, clientId, resource);
    if (!record.unexpired) throw invalidRefreshGrant();
    const effectiveScopes = narrowScopes(record.scopes, requestedScopes);
    await queryFn("UPDATE auth.oauth_refresh_tokens SET used_at = now() WHERE token_hash = $1", [tokenHash]);
    return insertTokenPair(queryFn, record.connectionId, effectiveScopes, dependencies);
  },
);

export const exchangeRefreshTokenWithDependencies = async (
  refreshToken: string,
  clientId: string,
  resource: string,
  requestedScopes: ReadonlyArray<string> | null,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthTokenResult> => {
  await cleanupExpiredOAuthState(dependencies.query);
  const tokenHash = hashOpaqueToken(refreshToken);
  const record = await readRefreshTokenBeforeOwnerCheck(tokenHash, dependencies);
  if (record.used) return rejectRefreshTokenReplay(tokenHash, dependencies);
  if (record.revoked) throw invalidRefreshGrant();
  validateRefreshTokenBinding(record, clientId, resource);
  if (!record.unexpired) throw invalidRefreshGrant();
  narrowScopes(record.scopes, requestedScopes);

  const ownerStatus = await dependencies.getCognitoOAuthOwnerStatus(record.userId);
  if (ownerStatus === "inactive") {
    await revokeActiveConnectionsForUser(record.userId, dependencies);
    throw invalidRefreshGrant();
  }

  // Cognito eligibility is a point-in-time snapshot. The locked read below
  // revalidates all refresh-token state without holding a row lock over AWS retries.
  const exchangeResult = await rotateRefreshToken(
    tokenHash,
    record.userId,
    clientId,
    resource,
    requestedScopes,
    dependencies,
  );
  if (exchangeResult === null) throw invalidRefreshGrant();
  return exchangeResult;
};

export const exchangeRefreshToken = (
  refreshToken: string,
  clientId: string,
  resource: string,
  requestedScopes: ReadonlyArray<string> | null,
): Promise<OAuthTokenResult> => exchangeRefreshTokenWithDependencies(
  refreshToken, clientId, resource, requestedScopes, defaultDependencies,
);
