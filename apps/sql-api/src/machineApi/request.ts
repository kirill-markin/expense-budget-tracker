import type { APIGatewayProxyEvent } from "aws-lambda";
import { buildAgentDiscoveryEnvelope } from "@expense-budget-tracker/agent-shared/discovery";
import type { UserIdentity } from "../db.js";
import type { AuthenticatedContext, JsonBody, MachineApiDependencies, MachineRouteContext } from "./types.js";

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const inferOrigin = (event: APIGatewayProxyEvent): string => {
  const host = event.headers.Host ?? event.headers.host ?? "api.example.com";
  const forwardedProto = event.headers["X-Forwarded-Proto"] ?? event.headers["x-forwarded-proto"] ?? "https";
  return `${forwardedProto}://${host}`;
};

export const getApiBaseUrl = (event: APIGatewayProxyEvent): string => {
  const configured = process.env.PUBLIC_API_BASE_URL;
  if (configured !== undefined && configured !== "") {
    return trimTrailingSlash(configured);
  }

  return `${trimTrailingSlash(inferOrigin(event))}/v1`;
};

export const getAuthBaseUrl = (event: APIGatewayProxyEvent): string => {
  const configured = process.env.PUBLIC_AUTH_BASE_URL;
  if (configured !== undefined && configured !== "") {
    return trimTrailingSlash(configured);
  }

  return trimTrailingSlash(getApiBaseUrl(event).replace("//api.", "//auth.").replace(/\/v1$/, ""));
};

export const getMcpUrl = (event: APIGatewayProxyEvent): string => {
  const authUrl = new URL(getAuthBaseUrl(event));
  if (!authUrl.hostname.startsWith("auth.")) {
    throw new Error(`Cannot derive MCP URL from auth host ${authUrl.hostname}`);
  }
  authUrl.hostname = `mcp.${authUrl.hostname.slice("auth.".length)}`;
  authUrl.pathname = "/mcp";
  authUrl.search = "";
  authUrl.hash = "";
  return authUrl.toString();
};

export const buildDiscoveryEnvelope = (event: APIGatewayProxyEvent): Readonly<Record<string, unknown>> => {
  const authBaseUrl = getAuthBaseUrl(event);

  return buildAgentDiscoveryEnvelope({
    apiBaseUrl: getApiBaseUrl(event),
    authBaseUrl,
    bootstrapUrl: `${authBaseUrl}/api/agent/send-code`,
    mcpUrl: getMcpUrl(event),
  });
};

// Single source for the machine API routing shapes, so the router and the
// container HTTP adapter can never drift apart.
export const DISCOVERY_PATHS: ReadonlySet<string> = new Set(["/", "/agent"]);

export const SOURCE_DISCOVERY_PATHS: ReadonlySet<string> = new Set(["/openapi.json", "/swagger.json"]);

// The only machine API route with a path parameter. The router matches it and
// the container adapter resolves {workspaceId} from the same pattern.
export const SELECT_WORKSPACE_PATH_PATTERN = /^\/workspaces\/(?<workspaceId>[^/]+)\/select$/u;

export const normalizeRoutePath = (rawPath: string): string => {
  const path = rawPath === "" ? "/" : rawPath;
  if (path === "/v1" || path === "/v1/") {
    return "/";
  }
  return path.startsWith("/v1/") ? path.slice(3) : path;
};

export const normalizePath = (event: APIGatewayProxyEvent): string => normalizeRoutePath(event.path);

export const readJsonBody = (event: APIGatewayProxyEvent): JsonBody | null => {
  if (event.body === null) {
    return null;
  }

  try {
    return JSON.parse(event.body) as JsonBody;
  } catch {
    return null;
  }
};

const getAuthorizerString = (
  event: APIGatewayProxyEvent,
  key: string,
): string => {
  const value = event.requestContext.authorizer?.[key];
  return typeof value === "string" ? value : "";
};

/**
 * Outcome of resolving the caller behind an ApiKey request.
 *
 * `account_disabled` covers both a user whose stored `cognito_enabled` is
 * false and a user whose `users` row no longer exists. The authorizer proves
 * that the presented secret hashed to an unrevoked key row whose LEFT JOINed
 * `users.email` was non-empty, and nothing beyond that:
 * `auth.validate_agent_api_key` returns neither `cognito_enabled` nor
 * `cognito_status`, so account state has to be read from `users` on every
 * request. Authorizer caching is not the reason: the `TokenAuthorizer` in
 * infra/aws/lib/api-gateway.ts sets `resultsCacheTtl` to zero.
 *
 * The missing-row arm is a live refusal rather than dead code, even though
 * agentApiKeyAuth.ts already answers 401 when that email is null, which is
 * what a deleted `users` row returns. The row can be deleted between the
 * authorizer's read and this one, and this read runs under `app.user_id` and
 * the `user_self_access` RLS policy on `users`, so a context that fails to
 * apply returns zero rows. Both must refuse rather than pass. It carries the
 * refused `userId` so the caller can log which account was cut off.
 */
export type AuthenticationOutcome =
  | Readonly<{ outcome: "missing_api_key" }>
  | Readonly<{ outcome: "account_disabled"; userId: string }>
  | Readonly<{ outcome: "authenticated"; authenticated: AuthenticatedContext }>;

/**
 * Resolve the authenticated context for an ApiKey request.
 *
 * The authorizer proves only that an unrevoked key exists for this user; it
 * proves nothing about the account still being active. So `cognito_status` and
 * `cognito_enabled` are read from the stored `users` row rather than asserted
 * here, a disabled account is refused, and the values the provisioning upsert
 * later writes back are the stored ones. A key holder therefore cannot
 * re-enable an account an operator disabled in the database.
 */
export const resolveAuthenticatedContext = async (
  event: APIGatewayProxyEvent,
  loadStoredIdentity: (userId: string) => Promise<UserIdentity | null>,
): Promise<AuthenticationOutcome> => {
  const userId = getAuthorizerString(event, "userId");
  const email = getAuthorizerString(event, "email");

  if (userId === "" || email === "") {
    return { outcome: "missing_api_key" };
  }

  const storedIdentity = await loadStoredIdentity(userId);
  if (storedIdentity === null || !storedIdentity.cognitoEnabled) {
    return { outcome: "account_disabled", userId };
  }

  return {
    outcome: "authenticated",
    authenticated: {
      identity: {
        userId,
        email,
        emailVerified: true,
        cognitoStatus: storedIdentity.cognitoStatus,
        cognitoEnabled: storedIdentity.cognitoEnabled,
      },
      connectionId: getAuthorizerString(event, "connectionId"),
      label: getAuthorizerString(event, "label"),
      createdAt: getAuthorizerString(event, "createdAt"),
      lastUsedAt: getAuthorizerString(event, "lastUsedAt") || null,
    },
  };
};

export const createMachineRouteContext = (
  event: APIGatewayProxyEvent,
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
): MachineRouteContext => ({
  event,
  dependencies,
  authenticated,
  apiBaseUrl: getApiBaseUrl(event),
  authBaseUrl: getAuthBaseUrl(event),
});
