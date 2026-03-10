import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ensureTrustedIdentityProvisioned, queryAsTrustedIdentity, type UserIdentity, withRestrictedTrustedIdentityContext } from "./db";
import { loadOpenApiDocument } from "./openapi";
import {
  executeExpenseSql,
  getAllowedRelationNames,
  MAX_SQL_ROWS,
  SQL_STATEMENT_TIMEOUT_MS,
  SqlPolicyError,
  type AllowedRelationName,
} from "../../web/src/server/sql/core";

type AuthenticatedContext = Readonly<{
  identity: UserIdentity;
  connectionId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}>;

type AgentAction = Readonly<{
  name: string;
  method: "GET" | "POST";
  url?: string;
  urlTemplate?: string;
  input?: Readonly<Record<string, string>>;
  auth?: "none" | "ApiKey";
}>;

type MachineApiDependencies = Readonly<{
  ensureTrustedIdentityProvisioned: typeof ensureTrustedIdentityProvisioned;
  loadOpenApiDocument: typeof loadOpenApiDocument;
  queryAsTrustedIdentity: typeof queryAsTrustedIdentity;
  withRestrictedTrustedIdentityContext: typeof withRestrictedTrustedIdentityContext;
}>;

type WorkspaceSummary = Readonly<{
  workspaceId: string;
  name: string;
}>;

type PgError = Error & Readonly<{
  code?: string;
}>;

type EntityHint = Readonly<{
  name: AllowedRelationName;
  summary: string;
}>;

type EntityHints = Readonly<{
  primary: EntityHint;
  related: ReadonlyArray<EntityHint>;
}>;

const SERVICE_NAME = "Expense Budget Tracker Agent API";
const SERVICE_DESCRIPTION = "Machine API for onboarding, workspace setup, and restricted SQL.";
const WORKSPACES_SQL = `SELECT w.workspace_id, w.name
  FROM workspaces w
  JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
  WHERE wm.user_id = $1
  ORDER BY w.name`;

const ENTITY_METADATA: Readonly<Record<AllowedRelationName, Readonly<{
  summary: string;
  related: ReadonlyArray<AllowedRelationName>;
}>>> = {
  ledger_entries: {
    summary: "One row per account movement, including income, spending, and transfers.",
    related: ["accounts", "workspace_settings", "account_metadata"],
  },
  accounts: {
    summary: "Derived account list built from ledger entries.",
    related: ["ledger_entries", "account_metadata", "workspace_settings"],
  },
  budget_lines: {
    summary: "Append-only monthly budget plan rows with last-write-wins semantics.",
    related: ["budget_comments", "workspace_settings"],
  },
  budget_comments: {
    summary: "Append-only comments attached to monthly budget categories.",
    related: ["budget_lines", "workspace_settings"],
  },
  workspace_settings: {
    summary: "Per-workspace reporting configuration such as reporting currency.",
    related: ["ledger_entries", "budget_lines", "accounts"],
  },
  account_metadata: {
    summary: "Per-account metadata such as liquidity classification.",
    related: ["accounts", "ledger_entries", "workspace_settings"],
  },
  exchange_rates: {
    summary: "Global FX rates used for query-time currency conversion.",
    related: ["workspace_settings", "ledger_entries", "budget_lines"],
  },
};

const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set(["22", "23", "42"]);

const json = (statusCode: number, body: Readonly<Record<string, unknown>>): APIGatewayProxyResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const buildSuccessEnvelope = (
  data: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<AgentAction>,
  instructions: string,
): Readonly<Record<string, unknown>> => ({
  ok: true,
  data,
  actions,
  instructions,
});

const buildErrorEnvelope = (
  data: Readonly<Record<string, unknown>>,
  actions: ReadonlyArray<AgentAction>,
  instructions: string,
  code: string,
  message: string,
): Readonly<Record<string, unknown>> => ({
  ok: false,
  data,
  actions,
  instructions,
  error: { code, message },
});

const trimTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

const inferOrigin = (event: APIGatewayProxyEvent): string => {
  const host = event.headers.Host ?? event.headers.host ?? "api.example.com";
  const forwardedProto = event.headers["X-Forwarded-Proto"] ?? event.headers["x-forwarded-proto"] ?? "https";
  return `${forwardedProto}://${host}`;
};

const getApiBaseUrl = (event: APIGatewayProxyEvent): string => {
  const configured = process.env.PUBLIC_API_BASE_URL;
  if (configured !== undefined && configured !== "") {
    return trimTrailingSlash(configured);
  }

  return `${trimTrailingSlash(inferOrigin(event))}/v1`;
};

const getAuthBaseUrl = (event: APIGatewayProxyEvent): string => {
  const configured = process.env.PUBLIC_AUTH_BASE_URL;
  if (configured !== undefined && configured !== "") {
    return trimTrailingSlash(configured);
  }

  return trimTrailingSlash(getApiBaseUrl(event).replace("//api.", "//auth.").replace(/\/v1$/, ""));
};

const buildDiscoveryEnvelope = (event: APIGatewayProxyEvent): Readonly<Record<string, unknown>> => {
  const apiBaseUrl = getApiBaseUrl(event);
  const authBaseUrl = getAuthBaseUrl(event);

  return buildSuccessEnvelope(
    {
      service: {
        name: SERVICE_NAME,
        version: "v1",
        description: SERVICE_DESCRIPTION,
      },
      auth: {
        bootstrapUrl: `${authBaseUrl}/api/agent/send-code`,
        scheme: "Authorization: ApiKey <key>",
      },
      apiBaseUrl,
      authBaseUrl,
      docs: {
        openapiUrl: `${apiBaseUrl}/openapi.json`,
        swaggerUrl: `${apiBaseUrl}/swagger.json`,
      },
      capabilities: [
        "Load account context",
        "Select a workspace",
        "Run restricted SQL",
      ],
    },
    [
      {
        name: "send_code",
        method: "POST",
        url: `${authBaseUrl}/api/agent/send-code`,
        input: { email: "string" },
        auth: "none",
      },
      {
        name: "openapi",
        method: "GET",
        url: `${apiBaseUrl}/openapi.json`,
        auth: "none",
      },
    ],
    `Start with send_code. After login, call ${apiBaseUrl}/me, then ${apiBaseUrl}/workspaces before SQL.`,
  );
};

const normalizePath = (event: APIGatewayProxyEvent): string => {
  const rawPath = event.path === "" ? "/" : event.path;
  if (rawPath === "/v1" || rawPath === "/v1/") {
    return "/";
  }
  return rawPath.startsWith("/v1/") ? rawPath.slice(3) : rawPath;
};

const readJsonBody = (event: APIGatewayProxyEvent): Readonly<Record<string, unknown>> | null => {
  if (event.body === null) {
    return null;
  }

  try {
    return JSON.parse(event.body) as Readonly<Record<string, unknown>>;
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

const getAuthenticatedContext = (event: APIGatewayProxyEvent): AuthenticatedContext | null => {
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

const mapWorkspaceRows = (rows: ReadonlyArray<unknown>): ReadonlyArray<WorkspaceSummary> =>
  rows.map((row) => {
    const typedRow = row as { workspace_id: string; name: string };
    return {
      workspaceId: typedRow.workspace_id,
      name: typedRow.name,
    };
  });

const listWorkspaces = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
): Promise<ReadonlyArray<WorkspaceSummary>> => {
  const result = await dependencies.queryAsTrustedIdentity(identity, identity.userId, WORKSPACES_SQL, [identity.userId]);
  return mapWorkspaceRows(result.rows);
};

const createWorkspace = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
  name: string,
): Promise<WorkspaceSummary> => {
  const result = await dependencies.queryAsTrustedIdentity(
    identity,
    identity.userId,
    "SELECT workspace_id, name FROM create_workspace_for_current_user($1)",
    [name],
  );

  if (result.rows.length !== 1) {
    throw new Error(`create_workspace_for_current_user returned ${result.rows.length} rows`);
  }

  const row = result.rows[0] as { workspace_id: string; name: string };
  return {
    workspaceId: row.workspace_id,
    name: row.name,
  };
};

const getWorkspace = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
  workspaceId: string,
): Promise<WorkspaceSummary | null> => {
  const result = await dependencies.queryAsTrustedIdentity(
    identity,
    identity.userId,
    `SELECT w.workspace_id, w.name
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
     WHERE w.workspace_id = $1
       AND wm.user_id = $2`,
    [workspaceId, identity.userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { workspace_id: string; name: string };
  return {
    workspaceId: row.workspace_id,
    name: row.name,
  };
};

const buildEntityHints = (relations: ReadonlyArray<AllowedRelationName>): EntityHints | undefined => {
  if (relations.length === 0) {
    return undefined;
  }

  const primaryName = relations[0];
  if (primaryName === undefined) {
    return undefined;
  }

  const relatedNames = Array.from(new Set([
    ...relations.filter((name) => name !== primaryName),
    ...ENTITY_METADATA[primaryName].related.filter((name) => name !== primaryName),
  ])).slice(0, 3);

  return {
    primary: {
      name: primaryName,
      summary: ENTITY_METADATA[primaryName].summary,
    },
    related: relatedNames.map((name) => ({
      name,
      summary: ENTITY_METADATA[name].summary,
    })),
  };
};

const isUserSqlExecutionError = (error: unknown): boolean => {
  const pgError = error as PgError;
  if (typeof pgError.code !== "string" || pgError.code.length < 2) {
    return false;
  }

  return USER_SQL_ERROR_CLASSES.has(pgError.code.slice(0, 2));
};

const getUserSqlExecutionMessage = (error: unknown): string => {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }

  return "The SQL statement could not be executed";
};

const runSql = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
  workspaceId: string,
  sql: string,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const workspace = await getWorkspace(dependencies, authenticated.identity, workspaceId);
  if (workspace === null) {
    return null;
  }

  const result = await executeExpenseSql(
    sql,
    async (validatedSql) => dependencies.withRestrictedTrustedIdentityContext(
      authenticated.identity,
      workspaceId,
      SQL_STATEMENT_TIMEOUT_MS,
      async (queryFn) => {
        const queryResult = await queryFn(validatedSql, []);
        return {
          rows: queryResult.rows as ReadonlyArray<Readonly<Record<string, unknown>>>,
          rowCount: queryResult.rowCount,
        };
      },
    ),
  );

  const entityHints = buildEntityHints(result.referencedRelations);

  return buildSuccessEnvelope(
    {
      rows: result.rows,
      rowCount: result.rowCount,
      workspace,
      ...(entityHints === undefined ? {} : { entityHints }),
      limits: {
        maxRows: MAX_SQL_ROWS,
        statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
      },
    },
    [],
    "Use X-Workspace-Id on every SQL request. Prefer SELECT first and only query supported relations.",
  );
};

export const createMachineApiHandler = (
  overrides: Partial<MachineApiDependencies> = {},
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
      return json(200, buildDiscoveryEnvelope(event));
    }

    if (event.httpMethod === "GET" && (path === "/openapi.json" || path === "/swagger.json")) {
      return json(200, dependencies.loadOpenApiDocument());
    }

    const authenticated = getAuthenticatedContext(event);
    if (authenticated === null) {
      return json(
        401,
        buildErrorEnvelope(
          {},
          [],
          "Send Authorization: ApiKey $EXPENSE_BUDGET_TRACKER_API_KEY.",
          "missing_api_key",
          "Missing ApiKey authorization",
        ),
      );
    }

    if (event.httpMethod === "GET" && path === "/me") {
      try {
        await dependencies.ensureTrustedIdentityProvisioned(authenticated.identity, authenticated.identity.userId);
        return json(
          200,
          buildSuccessEnvelope(
            {
              user: {
                userId: authenticated.identity.userId,
                email: authenticated.identity.email,
              },
              defaultWorkspaceId: authenticated.identity.userId,
              connection: {
                connectionId: authenticated.connectionId,
                label: authenticated.label,
                createdAt: authenticated.createdAt,
                lastUsedAt: authenticated.lastUsedAt,
              },
            },
            [{
              name: "list_workspaces",
              method: "GET",
              url: `${getApiBaseUrl(event)}/workspaces`,
              auth: "ApiKey",
            }],
            "Call /workspaces next, then choose a workspace ID for SQL.",
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(
          500,
          buildErrorEnvelope({ retryable: true }, [], "Retry /me in a moment.", "agent_me_failed", message),
        );
      }
    }

    if (event.httpMethod === "GET" && path === "/workspaces") {
      try {
        const workspaces = await listWorkspaces(dependencies, authenticated.identity);
        return json(
          200,
          buildSuccessEnvelope(
            { workspaces },
            [
              {
                name: "select_workspace",
                method: "POST",
                urlTemplate: `${getApiBaseUrl(event)}/workspaces/{workspaceId}/select`,
                auth: "ApiKey",
              },
              {
                name: "create_workspace",
                method: "POST",
                url: `${getApiBaseUrl(event)}/workspaces`,
                input: { name: "string" },
                auth: "ApiKey",
              },
            ],
            workspaces.length === 0
              ? "Create a workspace, then select it before SQL."
              : "Choose a workspaceId before SQL.",
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(
          500,
          buildErrorEnvelope(
            { retryable: true },
            [],
            `Retry ${getApiBaseUrl(event)}/workspaces in a moment.`,
            "agent_workspaces_failed",
            message,
          ),
        );
      }
    }

    if (event.httpMethod === "POST" && path === "/workspaces") {
      const body = readJsonBody(event);
      if (body === null) {
        return json(400, buildErrorEnvelope({}, [], "Send a JSON body with name.", "invalid_request", "Invalid JSON body"));
      }

      const rawName = body["name"];
      if (typeof rawName !== "string" || rawName.trim() === "") {
        return json(
          400,
          buildErrorEnvelope({ field: "name", expected: "non-empty string" }, [], "Provide a non-empty workspace name.", "invalid_workspace_name", "Workspace name is required"),
        );
      }

      const name = rawName.trim();
      if (name.length > 100) {
        return json(
          400,
          buildErrorEnvelope({ field: "name", expected: "string", maxLength: 100 }, [], "Workspace names must be 100 characters or fewer.", "invalid_workspace_name", "Workspace name is too long"),
        );
      }

      try {
        const workspace = await createWorkspace(dependencies, authenticated.identity, name);
        return json(
          200,
          buildSuccessEnvelope(
            { workspace },
            [{
              name: "select_workspace",
              method: "POST",
              urlTemplate: `${getApiBaseUrl(event)}/workspaces/{workspaceId}/select`,
              auth: "ApiKey",
            }],
            "Workspace created. Select it before SQL.",
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(
          500,
          buildErrorEnvelope({ retryable: true }, [], "Retry workspace creation in a moment.", "agent_workspace_create_failed", message),
        );
      }
    }

    if (event.httpMethod === "POST" && /^\/workspaces\/[^/]+\/select$/u.test(path)) {
      const workspaceId = event.pathParameters?.["workspaceId"]?.trim() ?? "";
      if (workspaceId === "") {
        return json(
          400,
          buildErrorEnvelope({ field: "workspaceId", expected: "non-empty string" }, [], "Provide a workspaceId path parameter.", "invalid_workspace_id", "Workspace ID is required"),
        );
      }

      try {
        const workspace = await getWorkspace(dependencies, authenticated.identity, workspaceId);
        if (workspace === null) {
          return json(
            404,
            buildErrorEnvelope({}, [], "Call /workspaces first and use one returned workspaceId.", "workspace_not_found", "Workspace not found"),
          );
        }

        return json(
          200,
          buildSuccessEnvelope(
            {
              workspace,
              sqlRequest: {
                header: "X-Workspace-Id",
                workspaceId: workspace.workspaceId,
              },
            },
            [{
              name: "run_sql",
              method: "POST",
              url: `${getApiBaseUrl(event)}/sql`,
              input: { sql: "string", "X-Workspace-Id": "string" },
              auth: "ApiKey",
            }],
            "Reuse this workspace ID in X-Workspace-Id for later SQL.",
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(
          500,
          buildErrorEnvelope({ retryable: true }, [], "Retry workspace selection in a moment.", "agent_workspace_select_failed", message),
        );
      }
    }

    if (event.httpMethod === "POST" && path === "/sql") {
      const body = readJsonBody(event);
      if (body === null) {
        return json(400, buildErrorEnvelope({}, [], "Send a JSON body with sql.", "invalid_request", "Invalid JSON body"));
      }

      const rawSql = body["sql"];
      if (typeof rawSql !== "string" || rawSql.trim() === "") {
        return json(
          400,
          buildErrorEnvelope({ field: "sql", expected: "non-empty string" }, [], "Send a non-empty sql string.", "missing_sql", "SQL is required"),
        );
      }

      const workspaceId = (event.headers["X-Workspace-Id"] ?? event.headers["x-workspace-id"] ?? "").trim();
      if (workspaceId === "") {
        return json(
          400,
          buildErrorEnvelope({ field: "X-Workspace-Id", expected: "workspaceId string" }, [], "Send X-Workspace-Id and retry.", "missing_workspace_id", "Workspace ID is required"),
        );
      }

      try {
        const response = await runSql(dependencies, authenticated, workspaceId, rawSql.trim());
        if (response === null) {
          return json(
            404,
            buildErrorEnvelope({}, [], "Call /workspaces first and use one returned workspaceId.", "workspace_not_found", "Workspace not found"),
          );
        }

        return json(200, response);
      } catch (error) {
        if (error instanceof SqlPolicyError) {
          return json(
            400,
            buildErrorEnvelope(
              { allowedRelations: getAllowedRelationNames() },
              [],
              "Use only supported relations and keep sending X-Workspace-Id.",
              error.code,
              error.message,
            ),
          );
        }

        if (isUserSqlExecutionError(error)) {
          return json(
            400,
            buildErrorEnvelope({}, [], "Review SQL syntax, relation names, and workspace ID, then retry.", "sql_execution_failed", getUserSqlExecutionMessage(error)),
          );
        }

        const message = error instanceof Error ? error.message : String(error);
        return json(
          500,
          buildErrorEnvelope({ retryable: true }, [], "Retry SQL in a moment.", "agent_sql_failed", message),
        );
      }
    }

    return json(404, { error: "Not found" });
  };
};
