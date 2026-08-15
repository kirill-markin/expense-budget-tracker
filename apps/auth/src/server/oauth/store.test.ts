import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import type { QueryFn } from "../db.js";
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

const createDependencies = (
  queryFn: QueryFn,
  tokens: Readonly<Record<"cl" | "ac" | "at" | "rt", ReadonlyArray<string>>>,
): OAuthStoreDependencies => {
  const offsets: Record<"cl" | "ac" | "at" | "rt", number> = { cl: 0, ac: 0, at: 0, rt: 0 };
  return {
    query: queryFn,
    withTransaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => callback(queryFn),
    createOpaqueToken: (prefix) => {
      const token = tokens[prefix][offsets[prefix]];
      if (token === undefined) throw new Error(`Missing test token for ${prefix}`);
      offsets[prefix] += 1;
      return token;
    },
    getCognitoOAuthOwnerStatus: async () => "active",
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
  let storedRefreshTokenHash: string | null = null;
  const accessTokenHashes = new Set<string>();
  const tokenInserts: Array<QueryCall> = [];
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_authorization_codes")) {
      assert.match(text, /FOR UPDATE OF oac, oc/u);
      return result([{
        connection_id: "connection-1",
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
  const queryFn: QueryFn = async (text, params) => {
    if (text.includes("FROM auth.oauth_authorization_codes")) {
      if (params[0] !== hash(knownCode)) return result([]);
      return result([{
        connection_id: "connection-1",
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
    withTransaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpen = true;
      try {
        return await callback(queryFn);
      } finally {
        transactionOpen = false;
      }
    },
    getCognitoOAuthOwnerStatus: async (requestedUserId) => {
      assert.equal(requestedUserId, "user-1");
      assert.equal(transactionOpen, false);
      sequence.push("cognito_check");
      return "active";
    },
  };

  await exchangeRefreshTokenWithDependencies(
    "ebt_rt_active-owner-presented",
    authorizationRequest.clientId,
    authorizationRequest.resource,
    null,
    activeDependencies,
  );

  assert.deepEqual(sequence, [
    "preflight_read",
    "cognito_check",
    "locked_read",
    "consume",
    "insert_access",
    "insert_refresh",
  ]);
});

test("inactive owners revoke every active OAuth connection and receive generic invalid_grant", async (): Promise<void> => {
  let consumed = false;
  let tokenInserted = false;
  let transactionOpened = false;
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
    getCognitoOAuthOwnerStatus: async () => "inactive",
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
    if (text.startsWith("UPDATE") || text.startsWith("INSERT")) mutationAttempted = true;
    return result([]);
  };
  const baseDependencies = createDependencies(queryFn, emptyTokens());
  const dependencies: OAuthStoreDependencies = {
    ...baseDependencies,
    withTransaction: async <T>(callback: (transactionQuery: QueryFn) => Promise<T>): Promise<T> => {
      transactionOpened = true;
      return callback(queryFn);
    },
    getCognitoOAuthOwnerStatus: async () => { throw transientFailure; },
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
    getCognitoOAuthOwnerStatus: async () => {
      ownerChecks += 1;
      if (ownerChecks === 1) {
        ownerActive = false;
        return "active";
      }
      return ownerActive ? "active" : "inactive";
    },
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
