import {
  buildAgentSuccessPayload,
  serializeAgentPayload,
  type AgentResultData,
} from "@expense-budget-tracker/agent-shared/agent-results";
import {
  createSqlExecutionDeadline,
  executeValidatedExpenseSqlWithinDeadline,
  getRemainingSqlExecutionMs,
  MAX_SQL_MUTATION_ROWS,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  type AllowedRelationName,
  type ExecutedExpenseSql,
  type SqlExecutionDeadline,
  type SqlExecutionDeadlineError,
  type SqlPolicyError,
  type ValidatedExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { ContentPart } from "@/server/chat/types";
import {
  applySqlResultCharBudget,
  type BudgetedSqlStatementEntry,
} from "@/server/sqlResultBudget";
import { withReadOnlyRestrictedUserContext, withUserContext } from "@/server/db";
import {
  DbTransactionOutcomeUnknownError,
  type QueryFn,
} from "@/server/db/contextRunner";
import { lockUncancelledChatTurnForMutationWithQuery } from "@/server/chat/store/turnCancellationStore";
import type { WorkspaceSummary } from "@/server/workspaces";

const formatDatetime = (timezone: string): string => {
  const now = new Date();
  const utc = now.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const local = now.toLocaleString("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  return `Current datetime — UTC: ${utc} | User local (${timezone}): ${local}`;
};

export const buildSystemInstructions = (timezone: string): string =>
  `${BASE_SYSTEM_INSTRUCTIONS}\n\n${formatDatetime(timezone)}`;

const WEB_CHAT_INSTRUCTIONS = `## This browser chat

The workspace the user currently has open is the default for every tool call: omit workspaceId to act on it. Pass an explicit workspaceId only to act on another accessible workspace that list_workspaces returned. Do not try to discover, list, or switch workspaces via SQL.
The user sees your replies in a narrow, vertical browser chat. Keep answers compact and easy to scan in a small chat column.
Use plain text only. Do not use Markdown, tables, fenced code blocks, bold or italic markers, or Markdown list syntax.
Prefer short paragraphs, simple label-value lines, and compact plain-text lists such as 1) and 2). When showing SQL or other structured content, present it as raw plain-text lines without Markdown wrappers.
When asking the user questions, use continuous numbering across the entire message, even when it contains two or more lists.
Be concise and direct.
The user may send data in any form: text, voice, photo/screenshot of a receipt or bank statement, PDF, or CSV file.
For CSV, XLS, and XLSX attachments, prefer the full raw tabular text already injected into the conversation when it is available. For those tabular formats, the original attached files also remain available separately for verification.
For PDF attachments, the app provides each page as extracted text immediately followed by a rendered page image. These are two representations of the same page: use the text for exact values and the image for layout, and never treat them as duplicate transactions.

## Tool use

Call get_schema before writing any SQL: these instructions carry no schema, so the relations, columns, and hints it returns are your only description of the database. Call it once per session and reuse that result for every later statement.
Call get_guide with topic sql_dialect before SQL that uses functions, case-insensitive matching, or date filters, and before any INSERT, UPDATE, or DELETE.
Call get_guide with topic query_recipes for balances, recent transactions, spending by category, plan versus actual, or FX conversion.
Before the first sql_execute of a task, call get_guide with topic writing_data, follow the protocol it returns, and obtain the user's explicit approval for the exact change set you described.
Verification after a write is a separate sql_query call, never part of the write call: one returned-row budget is shared across a single call.
Whenever you act on a workspace other than the one the user has open, name that workspace in your reply.

## Account Mentions

The user may tag existing accounts in plain text as @account_id when the ID uses letters, numbers, underscores, and hyphens, or as @"Account ID" with JSON-style escaping for other IDs.
A valid tag is an exact, case-sensitive account_id value. Multiple account tags may appear in one message.
Mention order alone never determines transfer direction. Use the user's prose to determine source and destination, and keep all existing transfer-pair and plan/confirmation rules authoritative.
If a tagged account is unknown or was deleted, surface it to the user for clarification. Never fuzzy-match the tag or silently create an account from it.`;

const BASE_SYSTEM_INSTRUCTIONS = `You are a financial assistant for an expense tracker app.
You have access to the user's expense database via the sql_query and sql_execute tools.
You can read data (SELECT) and write data (INSERT, UPDATE, DELETE).

${WEB_CHAT_INSTRUCTIONS}`;

/**
 * Chat-specific remediation added to a restricted SQL policy message. The shared
 * `instructions` field of the emitted envelope carries the next step, so a branch
 * belongs here only when it adds a fact the policy message itself lacks.
 */
export const getChatSqlPolicyMessage = (error: SqlPolicyError): string => {
  if (error.code === "unsupported_statement") {
    return error.message;
  }
  // The shared instructions say to split the script; without this, an old
  // transcript's two-statement transfer would be split into two calls, which are
  // now two transactions, and half a pair could commit on its own.
  if (error.code === "single_statement_required") {
    return `${error.message}. One call is one transaction, so rows that have to land together, such as both sides of a transfer, belong in one multi-row statement rather than in separate calls`;
  }
  if (
    error.code === "mutation_statement_row_limit_exceeded"
    || error.code === "mutation_request_row_limit_exceeded"
  ) {
    return `${error.message}. The whole call was rolled back, so nothing was written. Split the change into calls affecting at most ${String(MAX_SQL_MUTATION_ROWS)} rows each and retry`;
  }
  if (error.code === "on_conflict_not_allowed") {
    return "ON CONFLICT is not supported in chat queries";
  }
  if (error.code === "unsupported_sql_construct") {
    return error.message;
  }
  if (error.code === "set_config_not_allowed") {
    return "set_config() calls are not allowed";
  }
  if (error.code === "function_calls_not_allowed") {
    return error.message;
  }
  if (error.code === "sql_comments_not_allowed") {
    return "SQL comments are not allowed in chat queries";
  }
  if (error.code === "quoted_identifiers_not_allowed") {
    return "Quoted identifiers are not allowed in chat queries";
  }
  if (error.code === "dollar_quoted_strings_not_allowed") {
    return "Dollar-quoted strings are not allowed in chat queries";
  }
  if (error.code === "escape_string_literals_not_allowed") {
    return "PostgreSQL E'...' escape strings are unsupported in restricted SQL. Use ordinary single-quoted literals and represent embedded apostrophes by doubling them, for example 'customer''s'.";
  }
  if (error.code === "unterminated_string_literal") {
    return "Unterminated SQL string literal";
  }
  if (error.code === "invalid_relation_reference") {
    return "Expected relation name after SQL clause";
  }
  if (error.code === "relation_not_allowed") {
    return `${error.message} in chat queries`;
  }
  if (error.code === "recursive_cte_search_cycle_not_allowed") {
    return "Recursive CTE SEARCH and CYCLE clauses are not supported in chat queries. Rewrite the CTE without those clauses";
  }
  if (error.code === "read_only_relation_mutation_not_allowed") {
    return `${error.message}. Use SELECT to read it; write only to ledger_entries, budget_lines, workspace_settings, or account_metadata`;
  }
  return error.message;
};

export const getChatSqlDeadlineMessage = (error: SqlExecutionDeadlineError): string =>
  `${error.message}. Any writes in this call were rolled back. Ask for less work per call: a shorter date range or fewer rows`;

type PgError = Error & Readonly<{
  code?: string;
}>;

// Data exception, integrity constraint violation, and syntax or access rule
// violation: the three PostgreSQL error classes a statement's own text, values,
// or constraints produce, and the exact set
// apps/sql-api/src/machineApi/sqlService.ts gates the identical MCP branch on.
// Connection (08), resource (53), and operator-intervention (57) failures are
// deliberately absent: none of them is repaired by rewriting the statement.
// Cancellation (57014) is the one that does blame the statement, for being too
// slow rather than for being wrong, so the tool layer answers it as the
// deadline failure it is instead of asking for a rewrite.
const USER_SQL_ERROR_CLASSES: ReadonlySet<string> = new Set(["22", "23", "42"]);

// PostgreSQL cancelled the statement at the per-command statement_timeout this
// call sets from the deadline still left. The chat has no client-side backstop,
// and getRemainingSqlExecutionMs() is only consulted between commands, so for a
// single slow statement this cancellation, not SqlExecutionDeadlineError, is
// how the deadline actually expires. The cancellation aborts the transaction,
// so nothing this call wrote is applied.
const STATEMENT_TIMEOUT_ERROR_CODE = "57014";

export const CHAT_SQL_STATEMENT_TIMEOUT_MESSAGE = `SQL execution was cancelled after exceeding its ${String(MCP_SQL_STATEMENT_TIMEOUT_MS)} ms deadline. Any writes in this call were rolled back. Ask for less work per call: a shorter date range or fewer rows`;

const DEFAULT_USER_SQL_EXECUTION_MESSAGE = "The SQL statement could not be executed";

const getPgErrorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const pgError = error as PgError;
  return typeof pgError.code === "string" && pgError.code.length >= 2 ? pgError.code : null;
};

const isUserSqlDatabaseError = (error: unknown): boolean => {
  const code = getPgErrorCode(error);
  return code !== null && USER_SQL_ERROR_CLASSES.has(code.slice(0, 2));
};

export const isChatSqlStatementTimeoutError = (error: unknown): boolean =>
  getPgErrorCode(error) === STATEMENT_TIMEOUT_ERROR_CODE;

/**
 * The database rejected the statement the model wrote. This is the one execution
 * failure the model can repair on its own, so the tool layer forwards this
 * error's message verbatim and redacts everything else. Raised only at the one
 * call site that runs user SQL, the way
 * apps/sql-api/src/machineApi/sqlService.ts raises UserSqlExecutionError.
 */
export class ChatUserSqlExecutionError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ChatUserSqlExecutionError";
  }
}

export const isChatUserSqlExecutionError = (
  error: unknown,
): error is ChatUserSqlExecutionError => error instanceof ChatUserSqlExecutionError;

/**
 * A statement failure only counts as the model's to fix when PostgreSQL blamed
 * the statement's text, values, or constraints. Anything else — a dropped
 * connection, an exhausted resource, a statement cancelled at its timeout — is
 * rethrown untouched, so the tool layer answers it on its own terms rather than
 * asking the model to rewrite SQL that was never the problem: a cancellation
 * becomes the deadline failure it is, and everything else is redacted.
 */
export const throwChatUserSqlExecutionError = (error: unknown): never => {
  if (!isUserSqlDatabaseError(error)) {
    throw error;
  }
  throw new ChatUserSqlExecutionError(
    error instanceof Error && error.message !== ""
      ? error.message
      : DEFAULT_USER_SQL_EXECUTION_MESSAGE,
    error,
  );
};

/**
 * The model's mutating statement was issued to the database inside a
 * transaction that ended without a known outcome, so its writes may already be
 * durable and the model must verify the data instead of retrying. A transaction
 * that lost its outcome before issuing that statement, such as at the turn
 * lock, never raises this.
 */
export class ChatSqlMutationOutcomeUnknownError extends Error {
  public constructor(cause: DbTransactionOutcomeUnknownError) {
    super("The SQL mutation transaction outcome is unknown", { cause });
    this.name = "ChatSqlMutationOutcomeUnknownError";
  }
}

/** The serialized shared tool payload this call emits back into the chat turn. */
export type QueryResult = Readonly<{
  json: string;
}>;

export type ChatSqlExecutionContext = Readonly<{
  userId: string;
  /**
   * Workspace the browser session is attached to. Row-level security scopes the
   * chat session row to it, so the turn lock is only visible under this
   * workspace, whatever workspace the statement itself runs against.
   */
  workspaceId: string;
  sessionId: string;
  turnId: string;
}>;

type UserContextRunner = <T>(
  userId: string,
  workspaceId: string,
  callback: (queryFn: QueryFn) => Promise<T>,
) => Promise<T>;

type ReadOnlyRestrictedUserContextRunner = <T>(
  userId: string,
  workspaceId: string,
  statementTimeoutMs: number,
  callback: (queryFn: QueryFn) => Promise<T>,
) => Promise<T>;

export type ExecQueryDependencies = Readonly<{
  withUserContext: UserContextRunner;
  withReadOnlyRestrictedUserContext: ReadOnlyRestrictedUserContextRunner;
  lockUncancelledChatTurnForMutationWithQuery: typeof lockUncancelledChatTurnForMutationWithQuery;
  now: () => number;
}>;

const DEFAULT_EXEC_QUERY_DEPENDENCIES: ExecQueryDependencies = {
  withUserContext,
  withReadOnlyRestrictedUserContext,
  lockUncancelledChatTurnForMutationWithQuery,
  now: Date.now,
};

type ChatSqlStatementResult = Readonly<{
  sql: string;
  command: string;
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  rowCount: number;
  returnedRowCount: number;
  totalRowCount: number;
  truncated: boolean;
  referencedRelations: ReadonlyArray<AllowedRelationName>;
}>;

/**
 * Everything about this call that is fixed before execution: the workspace the
 * statement runs against, which may differ from the one the browser session has
 * open and is named in the result for that reason, and the instructions the
 * success payload carries. Knowing both up front is what lets the character
 * budget measure the exact output this call emits.
 */
export type ChatSqlTarget = Readonly<{
  workspace: WorkspaceSummary;
  instructions: string;
}>;

// The exact success output this call emits, in the same {ok, data, instructions}
// envelope the MCP surface emits: what the model reads now, what every later
// model call of the same turn re-sends, what the replay history stores, and what
// the transcript renders. The character budget is therefore measured on this
// whole envelope rather than on the statements alone.
const serializeChatSqlSuccessOutput = (
  target: ChatSqlTarget,
  statements: ReadonlyArray<ChatSqlStatementResult>,
): string => {
  const data: AgentResultData = { workspace: target.workspace, statements };
  return serializeAgentPayload(buildAgentSuccessPayload(data, target.instructions));
};

// The commit that ends this transaction runs after the call's last SQL command,
// under whatever statement_timeout that command left behind. PostgreSQL 18
// disarms the statement timeout in finish_xact_command() before it runs
// CommitTransactionCommand(), so a small residual does not actually abort the
// commit's work; this fixed allowance keeps that bound deterministic regardless,
// and matches the 10 s this path used before it moved to a shrinking deadline.
export const CHAT_SQL_COMMIT_TIMEOUT_MS = 10_000;

// Every database command of this call is bounded twice: the shared deadline caps
// the whole call client-side, and each command also carries the budget still
// left as its own server-side statement_timeout, the way
// apps/sql-api/src/dbDeadline.ts bounds the same executor's commands. Both paths
// run these commands under a restricted role — api_sql_executor on the mutation
// path, api_sql_reader on the read path — and
// db/migrations/0012_restrict_set_config.sql leaves EXECUTE on set_config() with
// app alone, so neither role can reach it and the timeout is set with SET LOCAL.
// SET takes no bind parameters, and every interpolated value is a positive safe
// integer: the one getRemainingSqlExecutionMs() returns, or the fixed commit
// allowance the last command restores for the commit the context runner issues
// next.
// Only the SET LOCAL statement_timeout command stays outside the wrap below: it
// is infrastructure, and a failure there is nothing the model can repair. Every
// request the shared executor issues through this callback is inside it,
// including the whole DECLARE/FETCH/MOVE/CLOSE cursor protocol a read runs. A
// cursor defers execution, so a runtime data error such as 22012 division by
// zero or 22P02 invalid input syntax surfaces at FETCH or MOVE rather than at
// DECLARE; narrowing the wrap to the model's own statement text would redact
// every one of them.
const runChatSqlWithinDeadline = async (
  queryFn: QueryFn,
  validated: ValidatedExpenseSql,
  deadline: SqlExecutionDeadline,
  onCommandIssued: (sql: string) => void,
): Promise<ExecutedExpenseSql> => {
  const executed = await executeValidatedExpenseSqlWithinDeadline(
    validated,
    deadline,
    async (request, remainingStatementTimeoutMs) => {
      await queryFn(
        `SET LOCAL statement_timeout = ${String(remainingStatementTimeoutMs)}`,
        [],
      );
      try {
        onCommandIssued(request.sql);
        return await queryFn(request.sql, request.params);
      } catch (error) {
        return throwChatUserSqlExecutionError(error);
      }
    },
  );

  await queryFn(
    `SET LOCAL statement_timeout = ${String(CHAT_SQL_COMMIT_TIMEOUT_MS)}`,
    [],
  );
  return executed;
};

// One budgeted result serves every consumer of this call: what the model reads
// now, what later model calls of the same turn re-send, the stored replay
// history, and the tool-output block the chat transcript renders. All of them
// show the same kept rows and the same truncated flag.
const applyChatSqlBudget = (
  target: ChatSqlTarget,
  executed: ExecutedExpenseSql,
): ReadonlyArray<ChatSqlStatementResult> => applySqlResultCharBudget(
  executed.statements.map((
    statement,
  ): BudgetedSqlStatementEntry<ChatSqlStatementResult> => ({
    statement: {
      sql: statement.sql,
      command: statement.command,
      rows: statement.rows,
      rowCount: statement.rowCount,
      returnedRowCount: statement.returnedRowCount,
      totalRowCount: statement.totalRowCount,
      truncated: statement.truncated,
      referencedRelations: statement.referencedRelations,
    },
    isMutating: statement.isMutating,
  })),
  (candidate) => serializeChatSqlSuccessOutput(target, candidate).length,
);

// The caller validates the statement and resolves the target workspace. Policy
// and deadline failures propagate to the tool layer, which is where the
// model-facing error envelope is built.
export const execQueryWithDependencies = async (
  validated: ValidatedExpenseSql,
  context: ChatSqlExecutionContext,
  target: ChatSqlTarget,
  dependencies: ExecQueryDependencies,
): Promise<QueryResult> => {
  const deadline = createSqlExecutionDeadline(
    MCP_SQL_STATEMENT_TIMEOUT_MS,
    dependencies.now,
  );

  const isMutating = validated.statements.some((statement) => statement.isMutating);
  let executed: ExecutedExpenseSql;
  if (isMutating) {
    const mutatingSql: ReadonlySet<string> = new Set(
      validated.statements
        .filter((statement) => statement.isMutating)
        .map((statement) => statement.sql),
    );
    let mutationIssued = false;
    try {
      executed = await dependencies.withUserContext(
        context.userId,
        // The session's workspace, not the target: the chat session row the turn
        // lock reads is invisible under any other workspace.
        context.workspaceId,
        async (queryFn) => {
          // Still the app role here, the only point of this transaction where
          // set_config() is reachable, and what bounds the turn lock below.
          await queryFn("SELECT set_config('statement_timeout', $1, true)", [
            String(getRemainingSqlExecutionMs(deadline)),
          ]);
          await dependencies.lockUncancelledChatTurnForMutationWithQuery(
            queryFn,
            context.sessionId,
            context.turnId,
          );
          // The row lock outlives this rebinding, so the turn stays fenced while
          // the statement runs against the workspace it was aimed at.
          await queryFn("SELECT set_config('app.workspace_id', $1, true)", [
            target.workspace.workspaceId,
          ]);
          await queryFn("SET LOCAL ROLE api_sql_executor", []);
          return runChatSqlWithinDeadline(
            queryFn,
            validated,
            deadline,
            (issuedSql) => {
              if (mutatingSql.has(issuedSql)) {
                mutationIssued = true;
              }
            },
          );
        },
      );
    } catch (error) {
      // Only the model's mutating statement, once issued, can have left writes
      // behind. An outcome lost before that, such as at the turn lock, is
      // rethrown unchanged for the tool layer to redact.
      if (error instanceof DbTransactionOutcomeUnknownError && mutationIssued) {
        throw new ChatSqlMutationOutcomeUnknownError(error);
      }
      throw error;
    }
  } else {
    // A read needs no chat session row, so it binds the target workspace
    // directly, in the repeatable-read read-only transaction under
    // api_sql_reader that SQL_QUERY_TOOL.description advertises. The role and
    // the transaction mode are what keep this path read-only independently of
    // the validator that accepted the statement.
    executed = await dependencies.withReadOnlyRestrictedUserContext(
      context.userId,
      target.workspace.workspaceId,
      MCP_SQL_STATEMENT_TIMEOUT_MS,
      async (queryFn) => runChatSqlWithinDeadline(
        queryFn,
        validated,
        deadline,
        (): void => {},
      ),
    );
  }

  return { json: serializeChatSqlSuccessOutput(target, applyChatSqlBudget(target, executed)) };
};

export const execQuery = async (
  validated: ValidatedExpenseSql,
  context: ChatSqlExecutionContext,
  target: ChatSqlTarget,
): Promise<QueryResult> =>
  execQueryWithDependencies(validated, context, target, DEFAULT_EXEC_QUERY_DEPENDENCIES);

export const extractText = (content: ReadonlyArray<ContentPart>): string =>
  content
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");

export const summarizeContent = (content: ReadonlyArray<ContentPart>): string => {
  const parts: Array<string> = [];
  for (const p of content) {
    if (p.type === "text") {
      parts.push(p.text);
    } else if (p.type === "image") {
      parts.push("[attached image]");
    } else if (p.type === "file") {
      parts.push(`[attached file: ${p.fileName}]`);
    } else if (p.type === "pdf") {
      parts.push(`[attached PDF: ${p.fileName}]`);
    }
  }
  return parts.join("\n");
};
