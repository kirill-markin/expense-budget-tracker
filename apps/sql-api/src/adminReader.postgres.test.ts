/**
 * Postgres-backed check of every admin-reader action, run as the admin_reader
 * role itself so its grants, read policies and read-only transactions are the
 * ones exercised.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { createSqlExecutionDeadline } from "@expense-budget-tracker/agent-shared/sql-policy";
import {
  ADMIN_READER_MAX_RESPONSE_BYTES,
  AdminReaderEventError,
  AdminReaderNotFoundError,
  AdminReaderResponseTooLargeError,
  type AdminReaderResponse,
  executeAdminReaderRequest,
  parseAdminReaderEvent,
} from "./adminReader.js";
import { systemDeadlineRuntime } from "./dbDeadline.js";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const adminReaderDatabaseUrl = process.env.ADMIN_READER_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || adminReaderDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and ADMIN_READER_DATABASE_URL are required for the Postgres-backed admin-reader test";
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

const read = (pool: pg.Pool, event: unknown, maxResponseBytes: number): Promise<AdminReaderResponse> =>
  executeAdminReaderRequest(
    pool,
    parseAdminReaderEvent(event),
    createSqlExecutionDeadline(10_000, Date.now),
    systemDeadlineRuntime,
    maxResponseBytes,
  );

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const insertSpan = async (
  ownerPool: pg.Pool,
  span: Readonly<{
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    name: string;
    startTime: string;
    userId: string;
    workspaceId: string;
    sessionId: string | null;
    attributes: Readonly<Record<string, string | number>>;
  }>,
): Promise<void> => {
  await ownerPool.query(
    `INSERT INTO public.llm_telemetry_spans (
       trace_id, span_id, parent_span_id, name, operation_name, status_code, status_message,
       start_time, end_time, user_id, workspace_id, session_id, attributes, resource_attributes
     ) VALUES ($1, $2, $3, $4, 'chat', 'ok', NULL, $5, $5::timestamptz + interval '1 second', $6, $7, $8, $9, '{"service.name":"web"}')`,
    [
      span.traceId,
      span.spanId,
      span.parentSpanId,
      span.name,
      span.startTime,
      span.userId,
      span.workspaceId,
      span.sessionId,
      JSON.stringify(span.attributes),
    ],
  );
};

test(
  "admin_reader reads users, sessions, items and spans in read-only transactions",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const suffix = randomUUID().replaceAll("-", "");
    const userId = `admin-reader-user-${suffix}`;
    const email = `admin-reader-${suffix}@example.invalid`;
    const workspaceId = `admin-reader-ws-${suffix}`;
    const sessionId = `admin-reader-session-${suffix}`;
    const traceId = randomBytes(16).toString("hex");
    const otherTraceId = randomBytes(16).toString("hex");
    const rootSpanId = randomBytes(8).toString("hex");
    const modelSpanId = randomBytes(8).toString("hex");
    const otherSpanId = randomBytes(8).toString("hex");
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const adminReaderPool = new pg.Pool({ connectionString: adminReaderDatabaseUrl, max: 1 });

    try {
      await ownerPool.query(
        "INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled) VALUES ($1, $2, true, 'CONFIRMED', true)",
        [userId, email],
      );
      await ownerPool.query("INSERT INTO public.workspaces (workspace_id, name) VALUES ($1, 'Investigated')", [workspaceId]);
      await ownerPool.query("INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2)", [workspaceId, userId]);
      await ownerPool.query(
        `INSERT INTO public.chat_sessions (session_id, user_id, workspace_id, status, title, last_message_at)
         VALUES ($1, $2, $3, 'idle', 'Budget question', '2026-11-01T10:00:00Z')`,
        [sessionId, userId, workspaceId],
      );
      for (const payload of [
        { role: "user", content: [{ type: "input_text", text: "How much did I spend?" }] },
        {
          role: "assistant",
          output: [
            { type: "reasoning", encrypted_content: "x".repeat(1_234), summary: [] },
            { type: "message", content: [{ type: "output_text", text: "About 100 EUR." }] },
          ],
          encrypted_content: null,
        },
        // Large enough to make the items the biggest part, and alone over a 15,000-byte limit.
        { role: "user", content: [{ type: "input_text", text: "y".repeat(20_000) }] },
      ]) {
        await ownerPool.query(
          "INSERT INTO public.chat_items (session_id, item_kind, state, payload) VALUES ($1, 'message', 'completed', $2)",
          [sessionId, JSON.stringify(payload)],
        );
      }
      // The padding makes the session's spans outweigh a single small item.
      const spanBase = { traceId, userId, workspaceId, sessionId };
      const spanPadding = "p".repeat(3_000);
      await insertSpan(ownerPool, {
        ...spanBase,
        spanId: modelSpanId,
        parentSpanId: rootSpanId,
        name: "chat gpt-test",
        startTime: "2026-11-01T10:00:01Z",
        attributes: {
          "gen_ai.usage.input_tokens": 1_000,
          "gen_ai.usage.output_tokens": 200,
          "gen_ai.usage.cache_read.input_tokens": 600,
          "gen_ai.usage.reasoning.output_tokens": 50,
          padding: spanPadding,
        },
      });
      await insertSpan(ownerPool, {
        ...spanBase,
        spanId: rootSpanId,
        parentSpanId: null,
        name: "invoke_agent web_chat",
        startTime: "2026-11-01T10:00:00Z",
        attributes: { "gen_ai.operation.name": "invoke_agent", padding: spanPadding },
      });
      await insertSpan(ownerPool, {
        ...spanBase,
        traceId: otherTraceId,
        spanId: otherSpanId,
        parentSpanId: null,
        name: "transcribe whisper-test",
        startTime: "2026-11-01T09:00:00Z",
        sessionId: null,
        attributes: { "gen_ai.operation.name": "transcribe" },
      });

      const found = await read(adminReaderPool, { action: "find_user", email: email.toUpperCase() }, ADMIN_READER_MAX_RESPONSE_BYTES);
      assert.deepEqual(found, {
        action: "find_user",
        users: [{ user_id: userId, email, workspaces: [{ workspace_id: workspaceId, name: "Investigated" }] }],
      });

      const listed = await read(adminReaderPool, { action: "list_sessions", userId, limit: 10 }, ADMIN_READER_MAX_RESPONSE_BYTES);
      assert.equal(listed.action, "list_sessions");
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0]?.session_id, sessionId);
      assert.equal(listed.sessions[0]?.title, "Budget question");
      assert.equal(listed.sessions[0]?.item_count, 3);
      assert.equal(listed.sessions[0]?.span_count, 2);
      assert.deepEqual(listed.sessions[0]?.tokens, {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_input_tokens: 600,
        reasoning_output_tokens: 50,
      });
      const listedLater = await read(
        adminReaderPool,
        { action: "list_sessions", workspaceId, since: "2026-11-02T00:00:00Z", limit: 10 },
        ADMIN_READER_MAX_RESPONSE_BYTES,
      );
      assert.deepEqual(listedLater, { action: "list_sessions", sessions: [] });

      const session = await read(
        adminReaderPool,
        { action: "get_session", sessionId, itemOffset: 1, itemLimit: 1, spanOffset: 0, spanLimit: 1 },
        ADMIN_READER_MAX_RESPONSE_BYTES,
      );
      assert.equal(session.action, "get_session");
      assert.equal(session.session.session_id, sessionId);
      assert.equal(session.item_count, 3);
      assert.equal(session.span_count, 2);
      assert.equal(session.items.length, 1);
      assert.deepEqual(session.items[0]?.payload, {
        role: "assistant",
        output: [
          { type: "reasoning", encrypted_content: { omitted: true, chars: 1_234 }, summary: [] },
          { type: "message", content: [{ type: "output_text", text: "About 100 EUR." }] },
        ],
        encrypted_content: null,
      });
      assert.deepEqual(session.spans.map((span) => span.span_id), [rootSpanId]);
      const nextSpans = await read(
        adminReaderPool,
        { action: "get_session", sessionId, itemOffset: 3, itemLimit: 1, spanOffset: 1, spanLimit: 500 },
        ADMIN_READER_MAX_RESPONSE_BYTES,
      );
      assert.equal(nextSpans.action, "get_session");
      assert.deepEqual(nextSpans.items, []);
      assert.deepEqual(nextSpans.spans.map((span) => span.span_id), [modelSpanId]);

      const trace = await read(adminReaderPool, { action: "get_trace", traceId: otherTraceId }, ADMIN_READER_MAX_RESPONSE_BYTES);
      assert.equal(trace.action, "get_trace");
      assert.deepEqual(trace.spans.map((span) => span.span_id), [otherSpanId]);
      assert.equal(trace.spans[0]?.session_id, null);

      // Each size check sets the limit one byte below the page's real size, so the remedy names the part that is too big.
      const wholePage = { action: "get_session", sessionId, itemOffset: 0, itemLimit: 200, spanOffset: 0, spanLimit: 500 };
      await assert.rejects(
        read(adminReaderPool, wholePage, jsonBytes(await read(adminReaderPool, wholePage, ADMIN_READER_MAX_RESPONSE_BYTES)) - 1),
        (error: unknown): boolean => error instanceof AdminReaderResponseTooLargeError
          && /the items are too big: lower itemLimit \(now 200\) and page with itemOffset/u.test(error.message),
      );
      const oneItemPage = { ...wholePage, itemLimit: 1 };
      await assert.rejects(
        read(adminReaderPool, oneItemPage, jsonBytes(await read(adminReaderPool, oneItemPage, ADMIN_READER_MAX_RESPONSE_BYTES)) - 1),
        (error: unknown): boolean => error instanceof AdminReaderResponseTooLargeError
          && /the spans are too big: lower spanLimit \(now 500\) and page with spanOffset/u.test(error.message),
      );
      await assert.rejects(
        read(adminReaderPool, wholePage, 15_000),
        (error: unknown): boolean => error instanceof AdminReaderResponseTooLargeError
          && /item \S+ at itemOffset 2 is \d+ bytes by itself and can never be returned; first read the 2 items before it with itemOffset 0 and itemLimit 2, then skip it with itemOffset 3/u.test(error.message),
      );
      const beforeOversizedItem = await read(adminReaderPool, { ...wholePage, itemLimit: 2 }, 15_000);
      assert.equal(beforeOversizedItem.action, "get_session");
      assert.equal(beforeOversizedItem.items.length, 2);
      const pastOversizedItem = await read(adminReaderPool, { ...wholePage, itemOffset: 3 }, 15_000);
      assert.equal(pastOversizedItem.action, "get_session");
      assert.equal(pastOversizedItem.spans.length, 2);
      await assert.rejects(
        read(
          adminReaderPool,
          { action: "get_session", sessionId: `${sessionId}-missing`, itemOffset: 0, itemLimit: 1, spanOffset: 0, spanLimit: 1 },
          ADMIN_READER_MAX_RESPONSE_BYTES,
        ),
        AdminReaderNotFoundError,
      );
      assert.throws(
        () => parseAdminReaderEvent({ action: "get_session", sessionId, itemOffset: 0, itemLimit: 1 }),
        (error: unknown): boolean => error instanceof AdminReaderEventError && /spanOffset/u.test(error.message),
      );
      assert.throws(
        () => parseAdminReaderEvent({ action: "list_sessions", limit: 10 }),
        (error: unknown): boolean => error instanceof AdminReaderEventError && /requires userId, workspaceId or both/u.test(error.message),
      );
      assert.throws(
        () => parseAdminReaderEvent({ action: "list_sessions", userId, limit: 10, sinse: "2026-11-01T00:00:00Z" }),
        AdminReaderEventError,
      );
    } finally {
      await ownerPool.query("DELETE FROM public.llm_telemetry_spans WHERE trace_id = ANY($1::text[])", [[traceId, otherTraceId]]);
      await ownerPool.query("DELETE FROM public.chat_sessions WHERE session_id = $1", [sessionId]);
      await ownerPool.query("DELETE FROM public.workspace_members WHERE workspace_id = $1", [workspaceId]);
      await ownerPool.query("DELETE FROM public.workspaces WHERE workspace_id = $1", [workspaceId]);
      await ownerPool.query("DELETE FROM public.users WHERE user_id = $1", [userId]);
      await adminReaderPool.end();
      await ownerPool.end();
    }
  },
);
