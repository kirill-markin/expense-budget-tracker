import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  ACCOUNT_DISABLED_INSTRUCTIONS,
  ACCOUNT_DISABLED_MESSAGE,
  AGENT_API_KEY_ENV_VAR_NAME,
  buildErrorEnvelope,
} from "@expense-budget-tracker/agent-shared";
import {
  SQL_STATEMENT_TIMEOUT_MS,
  createSqlExecutionDeadline,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  ensureTrustedIdentityProvisioned,
  loadTrustedUserIdentityBeforeDeadline,
  queryAsTrustedIdentity,
  queryAsTrustedIdentityBeforeDeadline,
  resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline,
  withReadOnlyRestrictedTrustedIdentityContext,
  withRestrictedTrustedIdentityContext,
} from "./db.js";
import { getSafeErrorType, log } from "./logger.js";
import {
  handleCreateWorkspaceRoute,
  handleDiscoveryRoute,
  handleListWorkspacesRoute,
  handleMeRoute,
  handleSchemaRoute,
  handleSelectWorkspaceRoute,
  handleSourceDiscoveryRoute,
  handleSqlExecuteRoute,
  handleSqlQueryRoute,
  handleSqlRoute,
} from "./machineApi/routeHandlers.js";
import {
  DISCOVERY_PATHS,
  SELECT_WORKSPACE_PATH_PATTERN,
  SOURCE_DISCOVERY_PATHS,
  createMachineRouteContext,
  normalizePath,
  resolveAuthenticatedContext,
  type AuthenticationOutcome,
} from "./machineApi/request.js";
import { buildRetryableErrorResponse, json } from "./machineApi/responses.js";
import type { MachineApiDependencies } from "./machineApi/types.js";

export const createMachineApiHandler = (
  overrides: Partial<MachineApiDependencies>,
): ((event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>) => {
  const dependencies: MachineApiDependencies = {
    ensureTrustedIdentityProvisioned,
    loadTrustedUserIdentityBeforeDeadline,
    log,
    queryAsTrustedIdentity,
    queryAsTrustedIdentityBeforeDeadline,
    resolveOrCreateWorkspaceForTrustedIdentityBeforeDeadline,
    withReadOnlyRestrictedTrustedIdentityContext,
    withRestrictedTrustedIdentityContext,
    ...overrides,
  };

  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const path = normalizePath(event);

    if (event.httpMethod === "GET" && DISCOVERY_PATHS.has(path)) {
      return handleDiscoveryRoute(event);
    }

    if (event.httpMethod === "GET" && SOURCE_DISCOVERY_PATHS.has(path)) {
      return handleSourceDiscoveryRoute(event);
    }

    // The account-state read is the first database touch of the request, so it
    // runs under the same deadline and the same retryable envelope the routes
    // use: an infrastructure fault must not escape as a raw gateway 502.
    // `resolveAuthenticatedContext` decides `missing_api_key` from the
    // authorizer context alone, before any database work, so an
    // unauthenticated request still answers 401 during a database outage.
    const authenticationDeadline = createSqlExecutionDeadline(SQL_STATEMENT_TIMEOUT_MS, Date.now);
    let authentication: AuthenticationOutcome;
    try {
      authentication = await resolveAuthenticatedContext(
        event,
        (userId) => dependencies.loadTrustedUserIdentityBeforeDeadline(userId, authenticationDeadline),
      );
    } catch (error) {
      dependencies.log({
        domain: "sql_api",
        action: "agent_auth_unavailable",
        errorType: getSafeErrorType(error),
      });
      return buildRetryableErrorResponse(
        "agent_auth_unavailable",
        "Retry the request in a moment.",
        error,
        { retryable: true },
      );
    }

    if (authentication.outcome === "missing_api_key") {
      return json(
        401,
        buildErrorEnvelope(
          {},
          [],
          `Send Authorization: ApiKey $${AGENT_API_KEY_ENV_VAR_NAME}.`,
          "missing_api_key",
          "Missing ApiKey authorization",
        ),
      );
    }

    if (authentication.outcome === "account_disabled") {
      dependencies.log({
        domain: "sql_api",
        action: "agent_account_disabled",
        userId: authentication.userId,
      });
      return json(
        403,
        buildErrorEnvelope(
          {},
          [],
          ACCOUNT_DISABLED_INSTRUCTIONS,
          "account_disabled",
          ACCOUNT_DISABLED_MESSAGE,
        ),
      );
    }

    const context = createMachineRouteContext(event, dependencies, authentication.authenticated);

    if (event.httpMethod === "GET" && path === "/me") {
      return handleMeRoute(context);
    }

    if (event.httpMethod === "GET" && path === "/schema") {
      return handleSchemaRoute(context);
    }

    if (event.httpMethod === "GET" && path === "/workspaces") {
      return handleListWorkspacesRoute(context);
    }

    if (event.httpMethod === "POST" && path === "/workspaces") {
      return handleCreateWorkspaceRoute(context);
    }

    if (event.httpMethod === "POST" && SELECT_WORKSPACE_PATH_PATTERN.test(path)) {
      return handleSelectWorkspaceRoute(context);
    }

    if (event.httpMethod === "POST" && path === "/sql") {
      return handleSqlRoute(context);
    }

    if (event.httpMethod === "POST" && path === "/sql/query") {
      return handleSqlQueryRoute(context);
    }

    if (event.httpMethod === "POST" && path === "/sql/execute") {
      return handleSqlExecuteRoute(context);
    }

    return json(404, { error: "Not found" });
  };
};
