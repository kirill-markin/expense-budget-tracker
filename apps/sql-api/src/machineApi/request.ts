import type { APIGatewayProxyEvent } from "aws-lambda";
import { buildAgentDiscoveryEnvelope } from "@expense-budget-tracker/agent-shared/discovery";
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

export const buildDiscoveryEnvelope = (event: APIGatewayProxyEvent): Readonly<Record<string, unknown>> => {
  const authBaseUrl = getAuthBaseUrl(event);

  return buildAgentDiscoveryEnvelope({
    apiBaseUrl: getApiBaseUrl(event),
    authBaseUrl,
    bootstrapUrl: `${authBaseUrl}/api/agent/send-code`,
  });
};

export const normalizePath = (event: APIGatewayProxyEvent): string => {
  const rawPath = event.path === "" ? "/" : event.path;
  if (rawPath === "/v1" || rawPath === "/v1/") {
    return "/";
  }
  return rawPath.startsWith("/v1/") ? rawPath.slice(3) : rawPath;
};

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

export const getAuthenticatedContext = (event: APIGatewayProxyEvent): AuthenticatedContext | null => {
  const userId = getAuthorizerString(event, "userId");
  const email = getAuthorizerString(event, "email");

  if (userId === "" || email === "") {
    return null;
  }

  return {
    identity: {
      userId,
      email,
      emailVerified: true,
      cognitoStatus: "CONFIRMED",
      cognitoEnabled: true,
    },
    connectionId: getAuthorizerString(event, "connectionId"),
    label: getAuthorizerString(event, "label"),
    createdAt: getAuthorizerString(event, "createdAt"),
    lastUsedAt: getAuthorizerString(event, "lastUsedAt") || null,
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
