import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ensureTrustedIdentityProvisioned, queryAsTrustedIdentity, type UserIdentity, withRestrictedTrustedIdentityContext } from "./db";
import { loadOpenApiDocument } from "./openapi";
import {
  AGENT_API_KEY_ENV_VAR_NAME,
  RUN_SQL_WITH_WORKSPACE_INPUT,
  buildCreateWorkspaceAction,
  buildErrorEnvelope,
  buildListWorkspacesAction,
  buildLoadAccountAction,
  buildRunSqlAction,
  buildSchemaAction,
  buildSelectWorkspaceAction,
  buildSuccessEnvelope,
} from "../../web/src/server/agentContract";
import { buildAgentDiscoveryEnvelope } from "../../web/src/server/agentDiscoveryContract";
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

type SchemaColumnRow = Readonly<{
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}>;

type SchemaColumn = Readonly<{
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
}>;

type SchemaRelation = Readonly<{
  name: AllowedRelationName;
  columns: ReadonlyArray<SchemaColumn>;
}>;

const WORKSPACES_SQL = `SELECT w.workspace_id, w.name
  FROM workspaces w
  JOIN workspace_members wm ON wm.workspace_id = w.workspace_id
  WHERE wm.user_id = $1
  ORDER BY w.name`;
const ALLOWED_RELATION_NAMES = getAllowedRelationNames();
const AGENT_CONNECTION_SELECT_SQL = `SELECT selected_workspace_id
  FROM auth.agent_api_keys
  WHERE connection_id = $1
    AND user_id = $2
    AND revoked_at IS NULL`;
const AGENT_CONNECTION_UPDATE_SQL = `UPDATE auth.agent_api_keys
  SET selected_workspace_id = $1
  WHERE connection_id = $2
    AND user_id = $3
    AND revoked_at IS NULL
  RETURNING connection_id`;

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

  return buildAgentDiscoveryEnvelope({
    apiBaseUrl,
    authBaseUrl,
    bootstrapUrl: `${authBaseUrl}/api/agent/send-code`,
  });
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

const persistSelectedWorkspace = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
  workspaceId: string,
): Promise<void> => {
  const result = await dependencies.queryAsTrustedIdentity(
    authenticated.identity,
    authenticated.identity.userId,
    AGENT_CONNECTION_UPDATE_SQL,
    [workspaceId, authenticated.connectionId, authenticated.identity.userId],
  );

  if (result.rows.length !== 1) {
    throw new Error(`Failed to persist selected workspace for connection ${authenticated.connectionId}`);
  }
};

const getSelectedWorkspace = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
): Promise<string | null> => {
  const result = await dependencies.queryAsTrustedIdentity(
    authenticated.identity,
    authenticated.identity.userId,
    AGENT_CONNECTION_SELECT_SQL,
    [authenticated.connectionId, authenticated.identity.userId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0] as { selected_workspace_id: string | null };
  return row.selected_workspace_id;
};

const resolveSqlWorkspaceId = async (
  dependencies: MachineApiDependencies,
  authenticated: AuthenticatedContext,
  headerWorkspaceId: string,
): Promise<string | null> => {
  if (headerWorkspaceId !== "") {
    return headerWorkspaceId;
  }

  const savedWorkspaceId = await getSelectedWorkspace(dependencies, authenticated);
  if (savedWorkspaceId !== null && savedWorkspaceId !== "") {
    return savedWorkspaceId;
  }

  const workspaces = await listWorkspaces(dependencies, authenticated.identity);
  if (workspaces.length !== 1) {
    return null;
  }

  const onlyWorkspace = workspaces[0];
  if (onlyWorkspace === undefined) {
    throw new Error("Expected exactly one workspace, but none were found");
  }

  await persistSelectedWorkspace(dependencies, authenticated, onlyWorkspace.workspaceId);
  return onlyWorkspace.workspaceId;
};

const loadAllowedSchema = async (
  dependencies: MachineApiDependencies,
  identity: UserIdentity,
): Promise<ReadonlyArray<SchemaRelation>> => {
  const result = await dependencies.queryAsTrustedIdentity(
    identity,
    identity.userId,
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [ALLOWED_RELATION_NAMES],
  );

  const grouped = new Map<AllowedRelationName, Array<SchemaColumn>>();
  for (const relationName of ALLOWED_RELATION_NAMES) {
    grouped.set(relationName, []);
  }

  for (const row of result.rows) {
    const typedRow = row as SchemaColumnRow;
    const relationName = typedRow.table_name as AllowedRelationName;
    if (!grouped.has(relationName)) {
      continue;
    }

    const columns = grouped.get(relationName);
    if (columns === undefined) {
      throw new Error(`Missing schema relation bucket for ${relationName}`);
    }

    const normalizedType = typedRow.data_type === "USER-DEFINED"
      ? typedRow.udt_name
      : typedRow.data_type;

    columns.push({
      name: typedRow.column_name,
      type: normalizedType,
      nullable: typedRow.is_nullable === "YES",
      defaultValue: typedRow.column_default,
    });
  }

  return ALLOWED_RELATION_NAMES.map((name) => {
    const columns = grouped.get(name);
    if (columns === undefined) {
      throw new Error(`Missing schema relation ${name}`);
    }

    return {
      name,
      columns,
    };
  });
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

const isSchemaExplorationAttempt = (message: string): boolean =>
  /information_schema|pg_catalog|pg_/iu.test(message);

const getSqlPolicyInstructions = (
  error: SqlPolicyError,
  apiBaseUrl: string,
): string => {
  if (error.code === "relation_not_allowed") {
    if (isSchemaExplorationAttempt(error.message)) {
      return `System catalogs are not queryable via /sql. Use ${apiBaseUrl}/schema to inspect allowed relations and columns, then query only those relations. Example: SELECT * FROM accounts LIMIT 0.`;
    }

    return `Relation is not exposed by policy. Use ${apiBaseUrl}/schema to see allowed relations, then retry. Workspace context must be set via /workspaces/{workspaceId}/select or X-Workspace-Id.`;
  }

  if (error.code === "unsupported_statement") {
    return "Use one SQL statement of type SELECT, WITH, INSERT, UPDATE, or DELETE. BEGIN/COMMIT/ROLLBACK and DDL are not allowed.";
  }

  if (error.code === "multiple_statements_not_allowed") {
    return "Send exactly one SQL statement per request. Remove semicolons and transaction wrappers.";
  }

  if (error.code === "set_config_not_allowed") {
    return "Do not call set_config(). User and workspace context are managed by the API.";
  }

  if (error.code === "sql_comments_not_allowed") {
    return "Remove SQL comments (`--` and `/* ... */`) and retry.";
  }

  if (error.code === "quoted_identifiers_not_allowed") {
    return "Quoted identifiers are not allowed. Use unquoted lower_snake_case relation and column names.";
  }

  if (error.code === "dollar_quoted_strings_not_allowed") {
    return "Dollar-quoted strings are not allowed. Use regular single-quoted literals.";
  }

  return "Fix the SQL statement and retry. Use only supported relations.";
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
    "Workspace context is required for SQL. Use X-Workspace-Id to override the saved workspace for this API key. Prefer SELECT first and only query supported relations.",
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
          `Send Authorization: ApiKey $${AGENT_API_KEY_ENV_VAR_NAME}.`,
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
            [
              buildListWorkspacesAction({ baseUrl: getApiBaseUrl(event), path: "/workspaces" }),
              buildSelectWorkspaceAction({ baseUrl: getApiBaseUrl(event), path: "/workspaces/{workspaceId}/select" }),
              buildSchemaAction({ baseUrl: getApiBaseUrl(event), path: "/schema" }),
            ],
            "Call /workspaces next, select a workspace once, then run SQL. Call /schema to inspect allowed relations and columns.",
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

    if (event.httpMethod === "GET" && path === "/schema") {
      try {
        const relations = await loadAllowedSchema(dependencies, authenticated.identity);
        return json(
          200,
          buildSuccessEnvelope(
            {
              relations,
              limits: {
                maxRows: MAX_SQL_ROWS,
                statementTimeoutMs: SQL_STATEMENT_TIMEOUT_MS,
              },
            },
            [
              buildRunSqlAction({ baseUrl: getApiBaseUrl(event), path: "/sql" }, RUN_SQL_WITH_WORKSPACE_INPUT),
            ],
            "Schema includes only relations supported by /sql. Select a workspace once, then run SQL.",
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(
          500,
          buildErrorEnvelope({ retryable: true }, [], "Retry /schema in a moment.", "agent_schema_failed", message),
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
              buildSelectWorkspaceAction({ baseUrl: getApiBaseUrl(event), path: "/workspaces/{workspaceId}/select" }),
              buildCreateWorkspaceAction({ baseUrl: getApiBaseUrl(event), path: "/workspaces" }),
            ],
            workspaces.length === 0
              ? "Create a workspace, then select it before SQL."
              : workspaces.length === 1
                ? "One workspace is available. Call /workspaces/{workspaceId}/select once to save it for this API key (or omit the header once and it will be auto-saved)."
                : "Multiple workspaces are available. Choose a workspaceId and call /workspaces/{workspaceId}/select once to save it for this API key.",
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
            [
              buildSelectWorkspaceAction({ baseUrl: getApiBaseUrl(event), path: "/workspaces/{workspaceId}/select" }),
            ],
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
        await persistSelectedWorkspace(dependencies, authenticated, workspace.workspaceId);

        return json(
          200,
          buildSuccessEnvelope(
            {
              workspace,
              sqlRequest: {
                header: "X-Workspace-Id",
                workspaceId: workspace.workspaceId,
                optionalAfterSelection: true,
              },
            },
            [
              buildRunSqlAction({ baseUrl: getApiBaseUrl(event), path: "/sql" }, RUN_SQL_WITH_WORKSPACE_INPUT),
            ],
            "Workspace saved for this API key. /sql can now omit X-Workspace-Id; send the header only to override.",
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

      const headerWorkspaceId = (event.headers["X-Workspace-Id"] ?? event.headers["x-workspace-id"] ?? "").trim();
      let workspaceId: string | null;
      try {
        workspaceId = await resolveSqlWorkspaceId(dependencies, authenticated, headerWorkspaceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(
          500,
          buildErrorEnvelope({ retryable: true }, [], "Retry SQL in a moment.", "agent_sql_failed", message),
        );
      }

      if (workspaceId === null || workspaceId === "") {
        return json(
          400,
          buildErrorEnvelope(
            { field: "X-Workspace-Id", expected: "workspaceId string" },
            [],
            "Send X-Workspace-Id, or call /workspaces/{workspaceId}/select once to save a default workspace for this API key.",
            "missing_workspace_id",
            "Workspace ID is required",
          ),
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
              getSqlPolicyInstructions(error, getApiBaseUrl(event)),
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
