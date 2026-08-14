import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handle } from "hono/aws-lambda";
import { type Context, Hono } from "hono";
import {
  authenticateMcpAccessToken,
  McpAuthenticationError,
  type AuthenticatedMcpAccessToken,
} from "./mcp/auth.js";
import { getMcpRuntimeConfig, type McpRuntimeConfig } from "./mcp/config.js";
import {
  buildBearerChallenge,
  buildProtectedResourceMetadata,
} from "./mcp/resourceMetadata.js";
import { createMcpServer } from "./mcp/server.js";
import { getSafeErrorType, log } from "./logger.js";

const BEARER_AUTHORIZATION_PATTERN = /^[Bb][Ee][Aa][Rr][Ee][Rr]\s+(ebt_at_[A-Za-z0-9_-]{43})$/u;

export type McpHandlerDependencies = Readonly<{
  authenticateMcpAccessToken: typeof authenticateMcpAccessToken;
  createMcpServer: typeof createMcpServer;
  getMcpRuntimeConfig: typeof getMcpRuntimeConfig;
  log: typeof log;
}>;

const defaultDependencies: McpHandlerDependencies = {
  authenticateMcpAccessToken,
  createMcpServer,
  getMcpRuntimeConfig,
  log,
};

const extractBearerAccessToken = (authorization: string | undefined): string | null => {
  if (authorization === undefined) {
    return null;
  }
  const match = BEARER_AUTHORIZATION_PATTERN.exec(authorization.trim());
  return match?.[1] ?? null;
};

const buildBearerChallengeResponse = (
  context: Context,
  config: McpRuntimeConfig,
): Response => context.json(
  {
    error: "invalid_token",
    error_description: "A valid OAuth Bearer access token is required for this MCP resource.",
  },
  401,
  { "WWW-Authenticate": buildBearerChallenge(config) },
);

const validateCanonicalRequestSource = (
  request: Request,
  config: McpRuntimeConfig,
): boolean => {
  const host = request.headers.get("host");
  if (host === null || host.toLowerCase() !== config.canonicalHost.toLowerCase()) {
    return false;
  }
  const origin = request.headers.get("origin");
  return origin === null || origin === config.resourceOrigin;
};

const handleMcpTransportRequest = async (
  request: Request,
  connection: AuthenticatedMcpAccessToken,
  config: McpRuntimeConfig,
  dependencies: McpHandlerDependencies,
): Promise<Response> => {
  const server = dependencies.createMcpServer(connection);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [config.canonicalHost],
    allowedOrigins: [config.resourceOrigin],
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
};

const buildMcpRoutes = (app: Hono, dependencies: McpHandlerDependencies): Hono => {
  app.get("/health", (context) => context.json({ status: "ok" }));

  const protectedResourceMetadata = (context: Context): Response => {
    const config = dependencies.getMcpRuntimeConfig();
    return context.json(buildProtectedResourceMetadata(config));
  };
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);

  app.all("/mcp", async (context): Promise<Response> => {
    const config = dependencies.getMcpRuntimeConfig();
    if (!validateCanonicalRequestSource(context.req.raw, config)) {
      return context.json(
        {
          error: "invalid_request_source",
          error_description: "The request Host or Origin is not allowed for this MCP resource.",
        },
        403,
      );
    }

    const token = extractBearerAccessToken(context.req.header("authorization"));
    if (token === null) {
      return buildBearerChallengeResponse(context, config);
    }

    let connection: AuthenticatedMcpAccessToken;
    try {
      connection = await dependencies.authenticateMcpAccessToken(token, config.resource);
    } catch (error) {
      if (error instanceof McpAuthenticationError) {
        return buildBearerChallengeResponse(context, config);
      }
      dependencies.log({
        domain: "sql_api",
        action: "mcp_unexpected_error",
        boundary: "authentication",
        operation: "validate_oauth_access_token",
        errorType: getSafeErrorType(error),
      });
      return context.json(
        { error: "internal_error", error_description: "The MCP request could not be authenticated." },
        500,
      );
    }

    if (context.req.method !== "POST") {
      return context.json(
        {
          error: "method_not_allowed",
          error_description: "The MCP resource only accepts POST in stateless JSON mode.",
        },
        405,
        { Allow: "POST" },
      );
    }

    return handleMcpTransportRequest(context.req.raw, connection, config, dependencies);
  });

  return app;
};

export const createMcpApp = (dependencies: McpHandlerDependencies): Hono => {
  const app = new Hono();
  app.route("/", buildMcpRoutes(new Hono(), dependencies));
  app.onError((error, context) => {
    dependencies.log({
      domain: "sql_api",
      action: "mcp_unexpected_error",
      boundary: "transport",
      operation: context.req.path,
      errorType: getSafeErrorType(error),
    });
    return context.json(
      { error: "internal_error", error_description: "The MCP request could not be completed." },
      500,
    );
  });
  return app;
};

export const createMcpHandler = (dependencies: McpHandlerDependencies) =>
  handle(createMcpApp(dependencies));

export const handler = createMcpHandler(defaultDependencies);
