import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { AGENT_API_KEY_ENV_VAR_NAME, buildErrorEnvelope } from "@expense-budget-tracker/agent-shared";
import { ensureTrustedIdentityProvisioned, queryAsTrustedIdentity, withRestrictedTrustedIdentityContext } from "./db.js";
import {
  handleCreateWorkspaceRoute,
  handleDiscoveryRoute,
  handleListWorkspacesRoute,
  handleMeRoute,
  handleOpenApiRoute,
  handleSchemaRoute,
  handleSelectWorkspaceRoute,
  handleSqlRoute,
} from "./machineApi/routeHandlers.js";
import { createMachineRouteContext, getAuthenticatedContext, normalizePath } from "./machineApi/request.js";
import { json } from "./machineApi/responses.js";
import type { MachineApiDependencies } from "./machineApi/types.js";
import { loadOpenApiDocument } from "./openapi.js";

export const createMachineApiHandler = (
  overrides: Partial<MachineApiDependencies>,
): ((event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>) => {
  const dependencies: MachineApiDependencies = {
    ensureTrustedIdentityProvisioned,
    loadOpenApiDocument,
    queryAsTrustedIdentity,
    withRestrictedTrustedIdentityContext,
    ...overrides,
  };

  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const path = normalizePath(event);

    if (event.httpMethod === "GET" && (path === "/" || path === "/agent")) {
      return handleDiscoveryRoute(event);
    }

    if (event.httpMethod === "GET" && (path === "/openapi.json" || path === "/swagger.json")) {
      return handleOpenApiRoute(dependencies);
    }

    const authenticated = getAuthenticatedContext(event);
    if (authenticated === null) {
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

    const context = createMachineRouteContext(event, dependencies, authenticated);

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

    if (event.httpMethod === "POST" && /^\/workspaces\/[^/]+\/select$/u.test(path)) {
      return handleSelectWorkspaceRoute(context);
    }

    if (event.httpMethod === "POST" && path === "/sql") {
      return handleSqlRoute(context);
    }

    return json(404, { error: "Not found" });
  };
};
