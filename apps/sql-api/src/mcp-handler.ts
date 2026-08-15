import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  createSqlExecutionDeadline,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  type SqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import { type Context, Hono } from "hono";
import {
  authenticateMcpAccessToken,
  McpAuthenticationError,
  type AuthenticatedMcpAccessToken,
} from "./mcp/auth.js";
import { getReadOnlyTransactionDeadlineError } from "./dbDeadline.js";
import { getMcpRuntimeConfig, type McpRuntimeConfig } from "./mcp/config.js";
import {
  buildBearerChallenge,
  buildProtectedResourceMetadata,
} from "./mcp/resourceMetadata.js";
import { createMcpServer } from "./mcp/server.js";
import { getSafeErrorType, log } from "./logger.js";

const BEARER_AUTHORIZATION_PATTERN = /^[Bb][Ee][Aa][Rr][Ee][Rr]\s+(ebt_at_[A-Za-z0-9_-]{43})$/u;

export class McpHttpApiV2EventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpHttpApiV2EventError";
  }
}

export type McpHandlerDependencies = Readonly<{
  authenticateMcpAccessToken: typeof authenticateMcpAccessToken;
  createMcpServer: typeof createMcpServer;
  getMcpRuntimeConfig: typeof getMcpRuntimeConfig;
  log: typeof log;
  now: () => number;
}>;

export type McpHttpApiV2Handler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

const defaultDependencies: McpHandlerDependencies = {
  authenticateMcpAccessToken,
  createMcpServer,
  getMcpRuntimeConfig,
  log,
  now: Date.now,
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

const buildHttpApiV2RequestUrl = (event: APIGatewayProxyEventV2): string => {
  if (event.version !== "2.0") {
    throw new McpHttpApiV2EventError("MCP Lambda requires an API Gateway HTTP API payload version 2.0 event.");
  }
  if (!event.rawPath.startsWith("/")) {
    throw new McpHttpApiV2EventError("MCP HTTP API event rawPath must start with '/'.");
  }

  const method = event.requestContext.http.method;
  const expectedRouteKey = `${method} ${event.rawPath}`;
  if (event.routeKey !== expectedRouteKey) {
    throw new McpHttpApiV2EventError(
      `MCP HTTP API event routeKey must be '${expectedRouteKey}'.`,
    );
  }
  if (event.requestContext.http.path !== event.rawPath) {
    throw new McpHttpApiV2EventError("MCP HTTP API event requestContext.http.path must match rawPath.");
  }

  const host = event.headers.host;
  if (host === undefined || host.trim() === "") {
    throw new McpHttpApiV2EventError("MCP HTTP API event is missing the required Host header.");
  }
  const querySuffix = event.rawQueryString === "" ? "" : `?${event.rawQueryString}`;
  return new URL(`${event.rawPath}${querySuffix}`, `https://${host}`).toString();
};

export const createMcpRequestFromHttpApiV2Event = (
  event: APIGatewayProxyEventV2,
): Request => {
  const url = buildHttpApiV2RequestUrl(event);
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    if (value !== undefined) {
      headers.append(name, value);
    }
  }
  if (event.cookies !== undefined) {
    if (headers.has("cookie")) {
      throw new McpHttpApiV2EventError("MCP HTTP API event must not duplicate cookies in headers and cookies.");
    }
    headers.set("cookie", event.cookies.join("; "));
  }

  const method = event.requestContext.http.method;
  if ((method === "GET" || method === "HEAD") && event.body !== undefined) {
    throw new McpHttpApiV2EventError(`MCP HTTP API ${method} event must not include a request body.`);
  }
  const body = event.body === undefined
    ? undefined
    : event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body;

  return new Request(url, { method, headers, body });
};

export const createHttpApiV2ResultFromMcpResponse = async (
  response: Response,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") {
      headers[name] = value;
    }
  });
  const cookies = response.headers.getSetCookie();

  return {
    statusCode: response.status,
    headers,
    ...(cookies.length === 0 ? {} : { cookies }),
    body: await response.text(),
    isBase64Encoded: false,
  };
};

const handleMcpTransportRequest = async (
  request: Request,
  connection: AuthenticatedMcpAccessToken,
  config: McpRuntimeConfig,
  deadline: SqlExecutionDeadline,
  dependencies: McpHandlerDependencies,
): Promise<Response> => {
  const server = dependencies.createMcpServer(connection, deadline);
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

const buildMcpRoutes = (
  app: Hono,
  dependencies: McpHandlerDependencies,
  createRequestDeadline: () => SqlExecutionDeadline,
): Hono => {
  const protectedResourceMetadata = (context: Context): Response => {
    const config = dependencies.getMcpRuntimeConfig();
    return context.json(buildProtectedResourceMetadata(config));
  };
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  app.on(["GET", "POST"], "/mcp", async (context): Promise<Response> => {
    const deadline = createRequestDeadline();
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
      connection = await dependencies.authenticateMcpAccessToken(
        token,
        config.resource,
        deadline,
      );
    } catch (error) {
      if (error instanceof McpAuthenticationError) {
        return buildBearerChallengeResponse(context, config);
      }
      const deadlineError = getReadOnlyTransactionDeadlineError(error);
      if (deadlineError !== null) {
        return context.json(
          {
            error: "request_deadline_exceeded",
            error_description: "The MCP request exceeded its 20-second total execution deadline. Retry the request.",
          },
          504,
        );
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

    return handleMcpTransportRequest(
      context.req.raw,
      connection,
      config,
      deadline,
      dependencies,
    );
  });

  return app;
};

const createMcpAppWithDeadlineFactory = (
  dependencies: McpHandlerDependencies,
  createRequestDeadline: () => SqlExecutionDeadline,
): Hono => {
  const app = new Hono();
  app.route("/", buildMcpRoutes(new Hono(), dependencies, createRequestDeadline));
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

export const createMcpApp = (dependencies: McpHandlerDependencies): Hono =>
  createMcpAppWithDeadlineFactory(
    dependencies,
    () => createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, dependencies.now),
  );

export const createMcpHandler = (
  dependencies: McpHandlerDependencies,
): McpHttpApiV2Handler =>
  async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const deadline = createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, dependencies.now);
    const request = createMcpRequestFromHttpApiV2Event(event);
    const app = createMcpAppWithDeadlineFactory(dependencies, () => deadline);
    const response = await app.fetch(request);
    return createHttpApiV2ResultFromMcpResponse(response);
  };

export const handler = createMcpHandler(defaultDependencies);
