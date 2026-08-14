import { query, withTransaction, type QueryFn } from "../db.js";
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
}>;

const defaultDependencies: OAuthStoreDependencies = { query, withTransaction, createOpaqueToken };

export type OAuthTokenResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresIn: 3600;
  scope: string;
}>;

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

export const issueAuthorizationCodeWithDependencies = async (
  request: AuthorizationRequest,
  userId: string,
  email: string,
  dependencies: OAuthStoreDependencies,
): Promise<string> => {
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

export const exchangeAuthorizationCodeWithDependencies = async (
  code: string,
  clientId: string,
  redirectUri: string,
  resource: string,
  codeVerifier: string,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthTokenResult> => {
  const invalidGrant = (): ReturnType<typeof oauthError> =>
    oauthError("invalid_grant", "Authorization code is invalid, expired, or already used", 400);
  const codeHash = hashOpaqueToken(code);
  const exchangeResult = await dependencies.withTransaction(async (queryFn: QueryFn): Promise<OAuthTokenResult | null> => {
    const result = await queryFn(
      `SELECT oac.connection_id, oac.redirect_uri, oac.code_challenge,
              oac.scopes, oac.used_at IS NOT NULL AS used,
              oac.expires_at > now() AS unexpired,
              oc.client_id, oc.resource, oc.revoked_at IS NOT NULL AS revoked
       FROM auth.oauth_authorization_codes oac
       JOIN auth.oauth_connections oc ON oc.connection_id = oac.connection_id
       WHERE oac.code_hash = $1
       FOR UPDATE OF oac, oc`,
      [codeHash],
    );
    if (result.rows.length !== 1) throw invalidGrant();
    const row = readRow(result.rows[0], "exchangeAuthorizationCode");
    const connectionId = readString(row, "connection_id", "exchangeAuthorizationCode");
    const revoked = readBoolean(row, "revoked", "exchangeAuthorizationCode");
    if (readBoolean(row, "used", "exchangeAuthorizationCode")) {
      if (!revoked) await revokeActiveConnection(queryFn, connectionId, "exchangeAuthorizationCode");
      return null;
    }
    if (revoked || !readBoolean(row, "unexpired", "exchangeAuthorizationCode")) throw invalidGrant();
    if (
      readString(row, "client_id", "exchangeAuthorizationCode") !== clientId
      || readString(row, "redirect_uri", "exchangeAuthorizationCode") !== redirectUri
      || readString(row, "resource", "exchangeAuthorizationCode") !== resource
      || !verifyCodeVerifier(codeVerifier, readString(row, "code_challenge", "exchangeAuthorizationCode"))
    ) {
      throw oauthError("invalid_grant", "Authorization code binding validation failed", 400);
    }
    const scopes = readScopes(row, "exchangeAuthorizationCode");
    await queryFn("UPDATE auth.oauth_authorization_codes SET used_at = now() WHERE code_hash = $1", [codeHash]);
    return insertTokenPair(queryFn, connectionId, scopes, dependencies);
  });
  if (exchangeResult === null) throw invalidGrant();
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

export const exchangeRefreshTokenWithDependencies = async (
  refreshToken: string,
  clientId: string,
  resource: string,
  requestedScopes: ReadonlyArray<string> | null,
  dependencies: OAuthStoreDependencies,
): Promise<OAuthTokenResult> => {
  const invalidGrant = (): ReturnType<typeof oauthError> =>
    oauthError("invalid_grant", "Refresh token is invalid, expired, or already used", 400);
  const tokenHash = hashOpaqueToken(refreshToken);
  const exchangeResult = await dependencies.withTransaction(async (queryFn: QueryFn): Promise<OAuthTokenResult | null> => {
    const result = await queryFn(
      `SELECT ort.connection_id, ort.scopes,
              ort.used_at IS NOT NULL AS used,
              ort.expires_at > now() AS unexpired,
              oc.client_id, oc.resource,
              oc.revoked_at IS NOT NULL AS revoked
       FROM auth.oauth_refresh_tokens ort
       JOIN auth.oauth_connections oc ON oc.connection_id = ort.connection_id
       WHERE ort.token_hash = $1
       FOR UPDATE OF ort, oc`,
      [tokenHash],
    );
    if (result.rows.length !== 1) throw invalidGrant();
    const row = readRow(result.rows[0], "exchangeRefreshToken");
    const connectionId = readString(row, "connection_id", "exchangeRefreshToken");
    const revoked = readBoolean(row, "revoked", "exchangeRefreshToken");
    if (readBoolean(row, "used", "exchangeRefreshToken")) {
      if (!revoked) await revokeActiveConnection(queryFn, connectionId, "exchangeRefreshToken");
      return null;
    }
    if (revoked) throw invalidGrant();
    if (
      readString(row, "client_id", "exchangeRefreshToken") !== clientId
      || readString(row, "resource", "exchangeRefreshToken") !== resource
    ) {
      throw oauthError("invalid_grant", "Refresh token binding validation failed", 400);
    }
    if (!readBoolean(row, "unexpired", "exchangeRefreshToken")) throw invalidGrant();
    const effectiveScopes = narrowScopes(readScopes(row, "exchangeRefreshToken"), requestedScopes);
    await queryFn("UPDATE auth.oauth_refresh_tokens SET used_at = now() WHERE token_hash = $1", [tokenHash]);
    return insertTokenPair(queryFn, connectionId, effectiveScopes, dependencies);
  });
  if (exchangeResult === null) throw invalidGrant();
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
