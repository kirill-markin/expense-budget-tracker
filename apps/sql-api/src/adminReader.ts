/**
 * Read-only owner investigations of any user's chats and LLM telemetry spans.
 *
 * Every request runs as the admin_reader role in one read-only transaction.
 * The role's read-only setting is only a session default, so the transaction
 * is opened read-only explicitly.
 */

import type pg from "pg";
import { z } from "zod";
import type { SqlExecutionDeadline } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  type DeadlinePool,
  type DeadlineRuntime,
  withReadOnlyDeadlineTransactionUsingPool,
} from "./dbDeadline.js";

// Lambda caps a synchronous response at 6 MB; the margin covers the runtime's
// own re-serialization of the returned object.
export const ADMIN_READER_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Strict objects: a misspelled filter must fail instead of silently widening the read.
const adminReaderEventSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("find_user"),
    email: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal("list_sessions"),
    userId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(100),
  }).refine(
    (event) => event.userId !== undefined || event.workspaceId !== undefined,
    { message: "list_sessions requires userId, workspaceId or both" },
  ),
  z.strictObject({
    action: z.literal("get_session"),
    sessionId: z.string().min(1),
    itemOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    itemLimit: z.number().int().min(1).max(200),
    spanOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    spanLimit: z.number().int().min(1).max(500),
  }),
  z.strictObject({
    action: z.literal("get_trace"),
    traceId: z.string().regex(/^[0-9a-f]{32}$/u, "traceId must be 32 lowercase hex characters"),
  }),
]);

export type AdminReaderEvent = z.infer<typeof adminReaderEventSchema>;

export class AdminReaderEventError extends Error {}

export class AdminReaderNotFoundError extends Error {}

export const parseAdminReaderEvent = (event: unknown): AdminReaderEvent => {
  const parsed = adminReaderEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new AdminReaderEventError(
      `Invalid admin-reader event: ${z.prettifyError(parsed.error)}. `
      + "Send one of find_user, list_sessions, get_session or get_trace as described in docs/admin-reader.md.",
    );
  }
  return parsed.data;
};

const jsonSchema = z.json();
const jsonObjectSchema = z.record(z.string(), jsonSchema);

const userSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  workspaces: z.array(z.object({ workspace_id: z.string(), name: z.string() })),
});

const sessionSummarySchema = z.object({
  session_id: z.string(),
  user_id: z.string(),
  workspace_id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_message_at: z.string().nullable(),
  item_count: z.number().int(),
  span_count: z.number().int(),
  tokens: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number(),
    reasoning_output_tokens: z.number(),
  }),
});

const sessionSchema = z.object({
  session_id: z.string(),
  user_id: z.string(),
  workspace_id: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  active_run_id: z.string().nullable(),
  active_run_heartbeat_at: z.string().nullable(),
  main_content_invalidation_version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  last_message_at: z.string().nullable(),
});

const itemSchema = z.object({
  item_id: z.string(),
  item_order: z.number().int(),
  state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  payload: jsonSchema,
});

const spanSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  name: z.string(),
  operation_name: z.string(),
  status_code: z.string(),
  status_message: z.string().nullable(),
  start_time: z.string(),
  end_time: z.string(),
  user_id: z.string(),
  workspace_id: z.string(),
  session_id: z.string().nullable(),
  attributes: jsonObjectSchema,
  resource_attributes: jsonObjectSchema,
  created_at: z.string(),
});

type JsonValue = z.infer<typeof jsonSchema>;
type ChatItem = z.infer<typeof itemSchema>;
type Span = z.infer<typeof spanSchema>;

export type AdminReaderResponse =
  | Readonly<{ action: "find_user"; users: ReadonlyArray<z.infer<typeof userSchema>> }>
  | Readonly<{ action: "list_sessions"; sessions: ReadonlyArray<z.infer<typeof sessionSummarySchema>> }>
  | Readonly<{
    action: "get_session";
    session: z.infer<typeof sessionSchema>;
    item_count: number;
    span_count: number;
    items: ReadonlyArray<ChatItem>;
    spans: ReadonlyArray<Span>;
  }>
  | Readonly<{ action: "get_trace"; spans: ReadonlyArray<Span> }>;

export type AdminReaderRowCounts = Readonly<Record<string, number>>;

type AdminReaderQueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<pg.QueryResult>;

/** Every query selects exactly one jsonb column named `row`. */
const readRows = <T>(result: pg.QueryResult, schema: z.ZodType<T>, source: string): ReadonlyArray<T> =>
  result.rows.map((row: unknown, index: number): T => {
    const parsed = z.object({ row: schema }).safeParse(row);
    if (!parsed.success) {
      throw new Error(`admin-reader ${source} row ${String(index)} has an unexpected shape: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data.row;
  });

/** Replaces each string under an `encrypted_content` key with its length; nothing else changes. */
export const omitEncryptedContent = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(omitEncryptedContent);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]): [string, JsonValue] =>
    key === "encrypted_content" && typeof entry === "string"
      ? [key, { omitted: true, chars: entry.length }]
      : [key, omitEncryptedContent(entry)]));
};

const findUser = async (
  queryFn: AdminReaderQueryFn,
  email: string,
): Promise<AdminReaderResponse> => {
  const result = await queryFn(
    `SELECT jsonb_build_object(
       'user_id', u.user_id,
       'email', u.email,
       'workspaces', COALESCE(
         jsonb_agg(jsonb_build_object('workspace_id', w.workspace_id, 'name', w.name) ORDER BY w.created_at, w.workspace_id)
           FILTER (WHERE w.workspace_id IS NOT NULL),
         '[]'::jsonb
       )
     ) AS row
     FROM public.users AS u
     LEFT JOIN public.workspace_members AS wm ON wm.user_id = u.user_id
     LEFT JOIN public.workspaces AS w ON w.workspace_id = wm.workspace_id
     WHERE lower(u.email) = lower($1)
     GROUP BY u.user_id, u.email
     ORDER BY u.user_id`,
    [email],
  );
  return { action: "find_user", users: readRows(result, userSchema, "find_user") };
};

// Token totals sum the OpenTelemetry GenAI usage attributes of the session's model-call spans.
const listSessions = async (
  queryFn: AdminReaderQueryFn,
  userId: string | null,
  workspaceId: string | null,
  since: string | null,
  limit: number,
): Promise<AdminReaderResponse> => {
  const result = await queryFn(
    `SELECT jsonb_build_object(
       'session_id', s.session_id,
       'user_id', s.user_id,
       'workspace_id', s.workspace_id,
       'title', s.title,
       'status', s.status,
       'created_at', s.created_at,
       'updated_at', s.updated_at,
       'last_message_at', s.last_message_at,
       'item_count', (SELECT count(*) FROM public.chat_items AS i WHERE i.session_id = s.session_id),
       'span_count', spans.span_count,
       'tokens', jsonb_build_object(
         'input_tokens', spans.input_tokens,
         'output_tokens', spans.output_tokens,
         'cache_read_input_tokens', spans.cache_read_input_tokens,
         'reasoning_output_tokens', spans.reasoning_output_tokens
       )
     ) AS row
     FROM (
       SELECT *
       FROM public.chat_sessions AS candidate
       WHERE ($1::text IS NULL OR candidate.user_id = $1::text)
         AND ($2::text IS NULL OR candidate.workspace_id = $2::text)
         AND ($3::timestamptz IS NULL OR COALESCE(candidate.last_message_at, candidate.created_at) >= $3::timestamptz)
       ORDER BY COALESCE(candidate.last_message_at, candidate.created_at) DESC, candidate.session_id DESC
       LIMIT $4
     ) AS s
     CROSS JOIN LATERAL (
       SELECT
         count(*) AS span_count,
         COALESCE(sum((t.attributes ->> 'gen_ai.usage.input_tokens')::numeric), 0) AS input_tokens,
         COALESCE(sum((t.attributes ->> 'gen_ai.usage.output_tokens')::numeric), 0) AS output_tokens,
         COALESCE(sum((t.attributes ->> 'gen_ai.usage.cache_read.input_tokens')::numeric), 0) AS cache_read_input_tokens,
         COALESCE(sum((t.attributes ->> 'gen_ai.usage.reasoning.output_tokens')::numeric), 0) AS reasoning_output_tokens
       FROM public.llm_telemetry_spans AS t
       WHERE t.session_id = s.session_id
     ) AS spans
     ORDER BY COALESCE(s.last_message_at, s.created_at) DESC, s.session_id DESC`,
    [userId, workspaceId, since, limit],
  );
  return { action: "list_sessions", sessions: readRows(result, sessionSummarySchema, "list_sessions") };
};

const readTraceSpans = async (
  queryFn: AdminReaderQueryFn,
  traceId: string,
): Promise<ReadonlyArray<Span>> => {
  const result = await queryFn(
    `SELECT to_jsonb(span) AS row
     FROM public.llm_telemetry_spans AS span
     WHERE span.trace_id = $1
     ORDER BY span.start_time, span.span_id`,
    [traceId],
  );
  return readRows(result, spanSchema, "llm_telemetry_spans");
};

const getSession = async (
  queryFn: AdminReaderQueryFn,
  sessionId: string,
  itemOffset: number,
  itemLimit: number,
  spanOffset: number,
  spanLimit: number,
): Promise<AdminReaderResponse> => {
  const sessionResult = await queryFn(
    `SELECT to_jsonb(s) || jsonb_build_object(
       'item_count', (SELECT count(*) FROM public.chat_items AS i WHERE i.session_id = s.session_id),
       'span_count', (SELECT count(*) FROM public.llm_telemetry_spans AS t WHERE t.session_id = s.session_id)
     ) AS row
     FROM public.chat_sessions AS s
     WHERE s.session_id = $1`,
    [sessionId],
  );
  const sessionRow = readRows(
    sessionResult,
    sessionSchema.extend({ item_count: z.number().int(), span_count: z.number().int() }),
    "chat_sessions",
  )[0];
  if (sessionRow === undefined) {
    throw new AdminReaderNotFoundError(`Chat session ${sessionId} does not exist; find session ids with list_sessions`);
  }
  const { item_count: itemCount, span_count: spanCount, ...session } = sessionRow;

  const itemsResult = await queryFn(
    `SELECT jsonb_build_object(
       'item_id', i.item_id,
       'item_order', i.item_order,
       'state', i.state,
       'created_at', i.created_at,
       'updated_at', i.updated_at,
       'payload', i.payload
     ) AS row
     FROM public.chat_items AS i
     WHERE i.session_id = $1
     ORDER BY i.item_order
     OFFSET $2
     LIMIT $3`,
    [sessionId, itemOffset, itemLimit],
  );
  const items = readRows(itemsResult, itemSchema, "chat_items").map((item): ChatItem => ({
    ...item,
    payload: omitEncryptedContent(item.payload),
  }));

  const spansResult = await queryFn(
    `SELECT to_jsonb(span) AS row
     FROM public.llm_telemetry_spans AS span
     WHERE span.session_id = $1
     ORDER BY span.start_time, span.span_id
     OFFSET $2
     LIMIT $3`,
    [sessionId, spanOffset, spanLimit],
  );

  return {
    action: "get_session",
    session,
    item_count: itemCount,
    span_count: spanCount,
    items,
    spans: readRows(spansResult, spanSchema, "llm_telemetry_spans"),
  };
};

const runAdminReaderQueries = async (
  queryFn: AdminReaderQueryFn,
  event: AdminReaderEvent,
): Promise<AdminReaderResponse> => {
  switch (event.action) {
    case "find_user":
      return findUser(queryFn, event.email);
    case "list_sessions":
      return listSessions(queryFn, event.userId ?? null, event.workspaceId ?? null, event.since ?? null, event.limit);
    case "get_session":
      return getSession(queryFn, event.sessionId, event.itemOffset, event.itemLimit, event.spanOffset, event.spanLimit);
    case "get_trace":
      return { action: "get_trace", spans: await readTraceSpans(queryFn, event.traceId) };
  }
};

export const countAdminReaderRows = (response: AdminReaderResponse): AdminReaderRowCounts => {
  switch (response.action) {
    case "find_user":
      return {
        users: response.users.length,
        workspaces: response.users.reduce((total, user) => total + user.workspaces.length, 0),
      };
    case "list_sessions":
      return { sessions: response.sessions.length };
    case "get_session":
      return { sessions: 1, items: response.items.length, spans: response.spans.length };
    case "get_trace":
      return { spans: response.spans.length };
  }
};

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const sumBytes = (sizes: ReadonlyArray<number>): number => sizes.reduce((total, size) => total + size, 0);

type GetSessionRequest = Extract<AdminReaderEvent, { action: "get_session" }>;
type GetSessionResponse = Extract<AdminReaderResponse, { action: "get_session" }>;

/**
 * Tells how to page past a row that can never be returned without losing the unread rows before it:
 * the failed call returned nothing, so rows offset … offset + index - 1 still need their own read.
 */
const describeSkipRemedy = (part: "item" | "span", offset: number, index: number): string => {
  const skip = `skip it with ${part}Offset ${String(offset + index + 1)}`;
  if (index === 0) {
    return skip;
  }
  return `first read the ${String(index)} ${part}s before it with ${part}Offset ${String(offset)} and ${part}Limit ${String(index)}, then ${skip}`;
};

/** Names the part of a get_session page that is too big and the one change that shrinks it. */
const describeGetSessionSizeRemedy = (
  event: GetSessionRequest,
  response: GetSessionResponse,
  maxResponseBytes: number,
): string => {
  const baseBytes = jsonBytes({ ...response, items: [], spans: [] });
  const itemBytes = response.items.map(jsonBytes);
  const spanBytes = response.spans.map(jsonBytes);
  const itemsBytes = sumBytes(itemBytes);
  const spansBytes = sumBytes(spanBytes);
  const sizes = `items are ${String(itemsBytes)} bytes (${String(response.items.length)} of item_count ${String(response.item_count)}), `
    + `spans are ${String(spansBytes)} bytes (${String(response.spans.length)} of span_count ${String(response.span_count)}); `;

  const oversizedItemIndex = itemBytes.findIndex((size) => baseBytes + size > maxResponseBytes);
  const oversizedItem = response.items[oversizedItemIndex];
  if (oversizedItem !== undefined) {
    const offset = event.itemOffset + oversizedItemIndex;
    return `${sizes}item ${oversizedItem.item_id} at itemOffset ${String(offset)} is ${String(itemBytes[oversizedItemIndex])} bytes `
      + `by itself and can never be returned; ${describeSkipRemedy("item", event.itemOffset, oversizedItemIndex)}`;
  }
  const oversizedSpanIndex = spanBytes.findIndex((size) => baseBytes + size > maxResponseBytes);
  const oversizedSpan = response.spans[oversizedSpanIndex];
  if (oversizedSpan !== undefined) {
    const offset = event.spanOffset + oversizedSpanIndex;
    return `${sizes}span ${oversizedSpan.span_id} at spanOffset ${String(offset)} is ${String(spanBytes[oversizedSpanIndex])} bytes `
      + `by itself and can never be returned; ${describeSkipRemedy("span", event.spanOffset, oversizedSpanIndex)}`;
  }

  const shrinkItems = `the items are too big: lower itemLimit (now ${String(event.itemLimit)}) and page with itemOffset`;
  const shrinkSpans = `the spans are too big: lower spanLimit (now ${String(event.spanLimit)}) and page with spanOffset`;
  const itemsAreLarger = itemsBytes >= spansBytes;
  // A one-row part cannot shrink by paging, so the other part has to.
  if (itemsAreLarger && response.items.length > 1) {
    return sizes + shrinkItems;
  }
  if (!itemsAreLarger && response.spans.length > 1) {
    return sizes + shrinkSpans;
  }
  if (response.items.length > 1) {
    return sizes + shrinkItems;
  }
  if (response.spans.length > 1) {
    return sizes + shrinkSpans;
  }
  return `${sizes}one item and one span do not fit together; read them in separate calls, `
    + `itemOffset ${String(response.item_count)} returns no items and spanOffset ${String(response.span_count)} returns no spans`;
};

const describeResponseSizeRemedy = (
  event: AdminReaderEvent,
  response: AdminReaderResponse,
  maxResponseBytes: number,
): string => {
  switch (event.action) {
    case "get_session":
      if (response.action !== "get_session") {
        throw new Error(`admin-reader get_session request produced a ${response.action} response`);
      }
      return describeGetSessionSizeRemedy(event, response, maxResponseBytes);
    case "list_sessions":
      return `lower limit (now ${String(event.limit)})`;
    case "find_user":
    case "get_trace":
      return `${event.action} cannot be paged`;
  }
};

export class AdminReaderResponseTooLargeError extends Error {
  readonly responseBytes: number;
  readonly maxResponseBytes: number;

  constructor(event: AdminReaderEvent, response: AdminReaderResponse, responseBytes: number, maxResponseBytes: number) {
    super(
      `admin-reader ${event.action} response is ${String(responseBytes)} bytes, over the ${String(maxResponseBytes)}-byte limit `
      + "below Lambda's 6 MB synchronous response cap; "
      + describeResponseSizeRemedy(event, response, maxResponseBytes),
    );
    this.responseBytes = responseBytes;
    this.maxResponseBytes = maxResponseBytes;
  }
}

export const executeAdminReaderRequest = async (
  pool: DeadlinePool,
  event: AdminReaderEvent,
  deadline: SqlExecutionDeadline,
  runtime: DeadlineRuntime,
  maxResponseBytes: number,
): Promise<AdminReaderResponse> => {
  const response = await withReadOnlyDeadlineTransactionUsingPool(
    pool,
    deadline,
    // REPEATABLE READ gives get_session one snapshot across its queries.
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    (transaction) => runAdminReaderQueries(
      (text, params) => transaction.query(text, params, deadline.timeoutMs),
      event,
    ),
    runtime,
  );
  const responseBytes = jsonBytes(response);
  if (responseBytes > maxResponseBytes) {
    throw new AdminReaderResponseTooLargeError(event, response, responseBytes, maxResponseBytes);
  }
  return response;
};
