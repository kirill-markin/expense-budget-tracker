import { z } from "zod";
import {
  SQL_EXECUTE_TOOL,
  SQL_QUERY_TOOL,
} from "@expense-budget-tracker/agent-shared/agent-tools";
import { ApiRouteError } from "@/server/api/errors";
import { handleRoute } from "@/server/api/handleRoute";
import { listChatWorkspaces } from "@/server/chat/dataService";
import {
  executeChatSqlCall,
  type ChatSqlCallDependencies,
} from "@/server/chat/openai/tooling/tools";
import {
  CHAT_SANDBOX_SQL_ROUTE_PATH,
  ChatSandboxSqlCapabilityError,
  verifyChatSandboxSqlAuthorization,
  type ChatSandboxSqlCapability,
} from "@/server/chat/sandbox/sqlCapability";
import { execWholeQuery } from "@/server/chat/shared";
import {
  ChatSessionRunTransitionError,
  lockActiveChatSessionRunWithQuery,
} from "@/server/chat/store";
import { withUserContext } from "@/server/db";
import { log, MAX_SANDBOX_SQL_LOG_CHARS } from "@/server/logger";

const requestBodySchema = z.object({
  kind: z.enum(["query", "execute"]),
  sql: z.string(),
  workspaceId: z.string().nullable(),
}).strict();

type ChatSandboxSqlRouteDependencies = Readonly<{
  now: () => number;
  createRequestId: () => string;
  requireActiveChatRun: (capability: ChatSandboxSqlCapability) => Promise<void>;
  sql: ChatSqlCallDependencies;
  log: typeof log;
}>;

type ActiveChatRunGateDependencies = Readonly<{
  withUserContext: typeof withUserContext;
  lockActiveChatSessionRunWithQuery: typeof lockActiveChatSessionRunWithQuery;
}>;

/**
 * A signed capability is not enough on its own: the run it names must still be
 * its session's running run. Read from Postgres rather than this task's memory,
 * because the sandbox's request may reach any web task.
 */
export const requireActiveChatRunWithDeps = async (
  capability: ChatSandboxSqlCapability,
  dependencies: ActiveChatRunGateDependencies,
): Promise<void> => {
  try {
    await dependencies.withUserContext(capability.userId, capability.workspaceId, async (queryFn) =>
      dependencies.lockActiveChatSessionRunWithQuery(
        queryFn,
        capability.sessionId,
        capability.activeRunId,
        "authorize chat sandbox SQL",
      ));
  } catch (error) {
    if (error instanceof ChatSessionRunTransitionError) {
      throw new ApiRouteError(
        403,
        "The chat run this command belongs to is no longer running, so its code may not reach the workspace data",
      );
    }
    throw error;
  }
};

export const DEFAULT_CHAT_SANDBOX_SQL_ROUTE_DEPENDENCIES: ChatSandboxSqlRouteDependencies = {
  now: Date.now,
  createRequestId: (): string => crypto.randomUUID(),
  requireActiveChatRun: (capability: ChatSandboxSqlCapability): Promise<void> =>
    requireActiveChatRunWithDeps(capability, { withUserContext, lockActiveChatSessionRunWithQuery }),
  sql: { execQuery: execWholeQuery, listChatWorkspaces, log },
  log,
};

const verifyCapability = (request: Request, nowMs: number): ChatSandboxSqlCapability => {
  try {
    return verifyChatSandboxSqlAuthorization(request.headers.get("authorization"), nowMs);
  } catch (error) {
    if (error instanceof ChatSandboxSqlCapabilityError) {
      throw new ApiRouteError(401, error.message);
    }
    throw error;
  }
};

const parseRequestBody = async (request: Request): Promise<z.infer<typeof requestBodySchema>> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiRouteError(400, "The chat sandbox SQL request body must be JSON");
  }
  const parsed = requestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiRouteError(
      400,
      "The body must be { kind: \"query\" | \"execute\", sql: string, workspaceId: string | null }",
    );
  }
  return parsed.data;
};

/**
 * One SQL call from the code of a `bash` command in the chat sandbox, run
 * exactly as the chat's own sql_query or sql_execute tool runs it, for the run
 * that minted the capability. The capability is the only authentication, so
 * the proxy exempts this path from session auth and CSRF.
 *
 * A failed statement still answers 200 with the tool's `{ ok: false }`
 * envelope; any other status means the statement did not run.
 */
export const chatSandboxSqlRouteWithDeps = async (
  request: Request,
  dependencies: ChatSandboxSqlRouteDependencies,
): Promise<Response> =>
  handleRoute(
    { route: CHAT_SANDBOX_SQL_ROUTE_PATH, method: "POST", internalErrorMessage: "Chat sandbox SQL failed" },
    async (): Promise<Response> => {
      const startedAt = dependencies.now();
      const capability = verifyCapability(request, startedAt);
      const body = await parseRequestBody(request);
      await dependencies.requireActiveChatRun(capability);

      const requestId = dependencies.createRequestId();
      const call = await executeChatSqlCall(
        body.kind === "query" ? SQL_QUERY_TOOL.name : SQL_EXECUTE_TOOL.name,
        { sql: body.sql, workspaceId: body.workspaceId },
        {
          requestId,
          userId: capability.userId,
          workspaceId: capability.workspaceId,
          sessionId: capability.sessionId,
          turnId: capability.activeRunId,
        },
        dependencies.sql,
      );
      dependencies.log({
        domain: "chat",
        action: "sandbox_sql",
        kind: body.kind,
        outcome: call.succeeded ? "succeeded" : "failed",
        errorCode: call.succeeded ? null : call.errorCode,
        sql: body.sql.slice(0, MAX_SANDBOX_SQL_LOG_CHARS),
        sqlChars: body.sql.length,
        durationMs: dependencies.now() - startedAt,
        requestId,
        userId: capability.userId,
        workspaceId: capability.workspaceId,
        sessionId: capability.sessionId,
        activeRunId: capability.activeRunId,
      });
      return new Response(call.output, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  );

export const POST = async (request: Request): Promise<Response> =>
  chatSandboxSqlRouteWithDeps(request, DEFAULT_CHAT_SANDBOX_SQL_ROUTE_DEPENDENCIES);
