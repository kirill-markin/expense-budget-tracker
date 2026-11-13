/**
 * The host end of the SQL bridge for one `bash` command.
 *
 * The interpreter's own network stays disabled: a command's code reaches SQL
 * only through the js-exec tool hook and the custom commands built on the
 * caller below, which run in this process and send the request themselves.
 * The bridge URL and the capability never reach anything the command can read,
 * including the messages it is handed when a call fails.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { SANDBOX_MAX_SQL_CALLS_PER_COMMAND, type ChatSandboxSqlBridge } from "./contract.js";

export type SqlCallKind = "query" | "execute";

export type SqlCallArguments = Readonly<{ sql: string; workspaceId: string | null }>;

/** A call that did not return the tool's success result; its message is what the command's code sees. */
export class SqlBridgeCallError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SqlBridgeCallError";
  }
}

/**
 * One SQL call from a command's code: resolves with the tool's success JSON as
 * the route sent it, and rejects with SqlBridgeCallError on every other answer.
 */
export type SqlBridgeCaller = (
  kind: SqlCallKind,
  args: SqlCallArguments,
  signal: AbortSignal | undefined,
) => Promise<string>;

/** The caller of a request that carried no bridge. */
export const unavailableSqlBridgeCaller: SqlBridgeCaller = async () => {
  throw new SqlBridgeCallError(
    "SQL from code is unavailable in this command: run the statement with the sql_query or sql_execute tool instead.",
  );
};

export const SQL_BRIDGE_USER_AGENT = "expense-budget-tracker-chat-sandbox";

const BRIDGE_RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 1_000, 2_000];

/** Ceiling on one attempt, below the command's own budget so a stalled call leaves time for another. */
const BRIDGE_ATTEMPT_TIMEOUT_MS = 30_000;

/** Failures raised before the request left, so even a write may repeat it without landing twice. */
const UNSENT_REQUEST_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Proxy answers for a request the web app may not have finished. */
const GATEWAY_FAILURE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const THROTTLED_STATUS = 429;

const MAX_FAILURE_BODY_CHARS = 1_000;

type AttemptOutcome =
  | Readonly<{ answered: true; status: number; body: string }>
  | Readonly<{ answered: false; error: unknown }>;

type SqlBridgeLogEvent = Readonly<{
  action: "sql_bridge_attempt_failed";
  kind: SqlCallKind;
  attempt: number;
  status: number | null;
  error: string | null;
  body: string | null;
  willRetry: boolean;
}>;

const log = (event: SqlBridgeLogEvent): void => {
  process.stdout.write(`${JSON.stringify({ domain: "chat_sandbox", ...event })}\n`);
};

const readNetworkErrorCode = (error: unknown): string | null => {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : null;
};

/** Network errors carry the host in their message, so only the error name and its cause code are kept. */
const describeNetworkError = (error: unknown): string => {
  const name = error instanceof Error ? error.name : typeof error;
  const code = readNetworkErrorCode(error);
  return code === null ? `errorName=${name}` : `errorName=${name} errorCode=${code}`;
};

const isUnsentRequestError = (error: unknown): boolean => {
  const code = readNetworkErrorCode(error);
  return code !== null && UNSENT_REQUEST_ERROR_CODES.has(code);
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
};

const cutBody = (body: string): string =>
  body.length <= MAX_FAILURE_BODY_CHARS ? body : `${body.slice(0, MAX_FAILURE_BODY_CHARS)}[truncated]`;

/**
 * What the command's code is told about an answer that was not a tool result.
 *
 * A JSON body is the web app's own answer and is quoted. Any other body is a
 * proxy or edge page, which names the host, so only its status is reported;
 * the log keeps the body.
 */
const describeOutcome = (outcome: AttemptOutcome): string => {
  if (!outcome.answered) {
    return describeNetworkError(outcome.error);
  }
  const parsed = parseJson(outcome.body);
  const body = typeof parsed === "object" && parsed !== null ? `: ${cutBody(outcome.body)}` : "";
  return `HTTP ${String(outcome.status)}${body}`;
};

/** Throttling and an unsent request refused the call before it ran; anything else is repeated only for a read. */
const isRetryable = (kind: SqlCallKind, outcome: AttemptOutcome): boolean => {
  if (outcome.answered) {
    return outcome.status === THROTTLED_STATUS
      || (kind === "query" && GATEWAY_FAILURE_STATUSES.has(outcome.status));
  }

  return kind === "query" || isUnsentRequestError(outcome.error);
};

const isWriteOutcomeUnknown = (kind: SqlCallKind, outcome: AttemptOutcome): boolean => {
  if (kind === "query") {
    return false;
  }

  return outcome.answered ? outcome.status >= 500 : !isUnsentRequestError(outcome.error);
};

const describeUnconfirmedWrite = (failure: string): string =>
  `The SQL bridge did not confirm this write (${failure}), so it may have been applied: read back with a SELECT before sending it again.`;

const toolEnvelopeSchema = z.object({ ok: z.boolean() });

/** The success envelope travels on as it arrived, for the code to parse; a failure envelope becomes the error. */
const readToolResult = (kind: SqlCallKind, body: string): string => {
  const envelope = toolEnvelopeSchema.safeParse(parseJson(body));
  if (!envelope.success) {
    const failure = "HTTP 200 without a tool result";
    throw new SqlBridgeCallError(kind === "execute"
      ? describeUnconfirmedWrite(failure)
      : `The SQL bridge did not complete this query call: ${failure}`);
  }
  if (!envelope.data.ok) {
    throw new SqlBridgeCallError(body);
  }

  return body;
};

const sendAttempt = async (
  bridge: ChatSandboxSqlBridge,
  body: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AttemptOutcome> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: {
        authorization: bridge.authorization,
        "content-type": "application/json",
        "user-agent": SQL_BRIDGE_USER_AGENT,
      },
      body,
      // A redirect would carry the statement to a host nobody validated; it is
      // reported as the status it is instead.
      redirect: "manual",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    return { answered: true, status: response.status, body: await response.text() };
  } catch (error) {
    // The command itself was cancelled, which is not a bridge failure to report.
    signal?.throwIfAborted();
    return { answered: false, error };
  }
};

const sendWithRetries = async (
  bridge: ChatSandboxSqlBridge,
  deadlineEpochMs: number,
  kind: SqlCallKind,
  args: SqlCallArguments,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const body = JSON.stringify({ kind, sql: args.sql, workspaceId: args.workspaceId });
  for (let attempt = 1; ; attempt += 1) {
    const remainingMs = deadlineEpochMs - Date.now();
    if (remainingMs <= 0) {
      throw new SqlBridgeCallError(
        `This bash command has no time left for another SQL ${kind} call: continue the work in another bash command.`,
      );
    }
    const outcome = await sendAttempt(bridge, body, Math.min(remainingMs, BRIDGE_ATTEMPT_TIMEOUT_MS), signal);
    if (outcome.answered && outcome.status === 200) {
      return readToolResult(kind, outcome.body);
    }

    const retryDelayMs = BRIDGE_RETRY_DELAYS_MS[attempt - 1];
    const willRetry = retryDelayMs !== undefined
      && isRetryable(kind, outcome)
      && Date.now() + retryDelayMs < deadlineEpochMs;
    log({
      action: "sql_bridge_attempt_failed",
      kind,
      attempt,
      status: outcome.answered ? outcome.status : null,
      error: outcome.answered ? null : describeNetworkError(outcome.error),
      body: outcome.answered ? cutBody(outcome.body) : null,
      willRetry,
    });
    if (!willRetry) {
      const failure = describeOutcome(outcome);
      throw new SqlBridgeCallError(isWriteOutcomeUnknown(kind, outcome)
        ? describeUnconfirmedWrite(failure)
        : `The SQL bridge did not complete this ${kind} call: ${failure}`);
    }

    await sleep(retryDelayMs, undefined, signal === undefined ? {} : { signal });
  }
};

/**
 * The caller of one command, bound to its bridge and its wall-clock deadline.
 *
 * Calls are sent one at a time, so `xargs -P` cannot push many into the web
 * app at once; the queue only orders them, and each caller still receives its
 * own failure. The cap counts every call the code makes, failed ones included.
 */
export const createSqlBridgeCaller = (
  bridge: ChatSandboxSqlBridge,
  deadlineEpochMs: number,
): SqlBridgeCaller => {
  let calls = 0;
  let queue: Promise<unknown> = Promise.resolve();

  return async (kind, args, signal) => {
    if (calls >= SANDBOX_MAX_SQL_CALLS_PER_COMMAND) {
      throw new SqlBridgeCallError(
        `This bash command already made ${String(SANDBOX_MAX_SQL_CALLS_PER_COMMAND)} SQL calls, the most one command may make: continue the work in another bash command.`,
      );
    }
    calls += 1;
    const result = queue.then(() => sendWithRetries(bridge, deadlineEpochMs, kind, args, signal));
    queue = result.catch(() => undefined);
    return result;
  };
};
