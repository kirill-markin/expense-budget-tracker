/**
 * Postgres-backed pin for the span exporter: only a real database proves that
 * the `app` role can write the batch with no RLS context, that the row shape
 * matches migration 0088, and that a rejected batch reaches the processor as a
 * FAILED result instead of a throw.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_USER_ID,
} from "@opentelemetry/semantic-conventions/incubating";
import pg from "pg";

import { PostgresSpanExporter } from "@/server/telemetry/postgresSpanExporter";
import { ATTR_APP_TURN_ID, ATTR_APP_WORKSPACE_ID, TELEMETRY_TRACER_NAME } from "@/server/telemetry/tracer";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? "";
const appDatabaseUrl = process.env.APP_DATABASE_URL ?? "";
const databaseUrlsMissing = migrationDatabaseUrl === "" || appDatabaseUrl === "";
const MISSING_DATABASE_URLS_MESSAGE =
  "MIGRATION_DATABASE_URL and APP_DATABASE_URL are required for the Postgres-backed span exporter test";
// CI has to prove the app role can really write spans, so missing wiring fails there instead of skipping.
const postgresTestSkip: boolean | string = databaseUrlsMissing && process.env.CI !== "true"
  ? MISSING_DATABASE_URLS_MESSAGE
  : false;

type Fixture = Readonly<{ userId: string; workspaceId: string; sessionId: string }>;

type StoredSpanRow = Readonly<{
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  operation_name: string;
  status_code: string;
  status_message: string | null;
  start_micros: string;
  end_micros: string;
  user_id: string;
  workspace_id: string;
  session_id: string | null;
  attributes: Readonly<Record<string, string | number>>;
  resource_attributes: Readonly<Record<string, string | number>>;
}>;

const ROOT_START: [number, number] = [1_790_000_000, 123_456_000];
const ROOT_END: [number, number] = [1_790_000_002, 0];
const CHILD_START: [number, number] = [1_790_000_000, 500_000_000];
const CHILD_END: [number, number] = [1_790_000_001, 750_000_000];

const createFixture = (): Fixture => {
  const suffix = randomUUID().replaceAll("-", "");
  return {
    userId: `span-exporter-user-${suffix}`,
    workspaceId: `span-exporter-workspace-${suffix}`,
    sessionId: `span-exporter-session-${suffix}`,
  };
};

const insertFixture = async (pool: pg.Pool, fixture: Fixture): Promise<void> => {
  await pool.query(
    `INSERT INTO public.users (user_id, email, email_verified, cognito_status, cognito_enabled)
     VALUES ($1, $2, true, 'CONFIRMED', true)`,
    [fixture.userId, `${fixture.userId}@example.invalid`],
  );
  await pool.query("INSERT INTO public.workspaces (workspace_id, name) VALUES ($1, $2)", [
    fixture.workspaceId,
    "span exporter test",
  ]);
  await pool.query("INSERT INTO public.workspace_members (workspace_id, user_id) VALUES ($1, $2)", [
    fixture.workspaceId,
    fixture.userId,
  ]);
  await pool.query(
    "INSERT INTO public.chat_sessions (session_id, user_id, workspace_id, status) VALUES ($1, $2, $3, 'idle')",
    [fixture.sessionId, fixture.userId, fixture.workspaceId],
  );
};

const deleteFixture = async (pool: pg.Pool, fixture: Fixture): Promise<void> => {
  await pool.query("DELETE FROM public.chat_sessions WHERE workspace_id = $1", [fixture.workspaceId]);
  await pool.query("DELETE FROM public.workspace_members WHERE workspace_id = $1", [fixture.workspaceId]);
  await pool.query("DELETE FROM public.workspaces WHERE workspace_id = $1", [fixture.workspaceId]);
  await pool.query("DELETE FROM public.users WHERE user_id = $1", [fixture.userId]);
};

const readSpanRows = async (pool: pg.Pool, workspaceId: string): Promise<ReadonlyArray<StoredSpanRow>> => {
  const result = await pool.query(
    `SELECT trace_id, span_id, parent_span_id, name, operation_name, status_code, status_message,
            (EXTRACT(EPOCH FROM start_time) * 1000000)::BIGINT::TEXT AS start_micros,
            (EXTRACT(EPOCH FROM end_time) * 1000000)::BIGINT::TEXT AS end_micros,
            user_id, workspace_id, session_id, attributes, resource_attributes
       FROM public.llm_telemetry_spans
      WHERE workspace_id = $1
      ORDER BY start_time`,
    [workspaceId],
  );
  return result.rows as ReadonlyArray<StoredSpanRow>;
};

const toMicros = (time: [number, number]): string =>
  String(time[0] * 1_000_000 + time[1] / 1_000);

const exportSpans = (
  exporter: PostgresSpanExporter,
  spans: ReadonlyArray<ReadableSpan>,
): Promise<ExportResult> =>
  new Promise((resolve): void => {
    exporter.export([...spans], resolve);
  });

/** Real SDK spans for one chat turn: a root, a child, and one span from a foreign tracer. */
const recordSpans = (
  fixture: Fixture,
): Readonly<{ spans: ReadonlyArray<ReadableSpan>; rootName: string; childName: string }> => {
  const memoryExporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] });
  const tracer = provider.getTracer(TELEMETRY_TRACER_NAME);
  const linkAttributes = {
    [ATTR_USER_ID]: fixture.userId,
    [ATTR_APP_WORKSPACE_ID]: fixture.workspaceId,
    [ATTR_GEN_AI_CONVERSATION_ID]: fixture.sessionId,
  };

  const root = tracer.startSpan("invoke_agent chat", {
    startTime: ROOT_START,
    attributes: { ...linkAttributes, [ATTR_GEN_AI_OPERATION_NAME]: "invoke_agent", [ATTR_APP_TURN_ID]: "turn-1" },
  });
  const child = tracer.startSpan(
    "chat gpt-test",
    { startTime: CHILD_START, attributes: { ...linkAttributes, [ATTR_GEN_AI_OPERATION_NAME]: "chat" } },
    trace.setSpan(context.active(), root),
  );
  child.setStatus({ code: SpanStatusCode.ERROR, message: "model stream failed" });
  child.end(CHILD_END);
  root.setStatus({ code: SpanStatusCode.OK });
  root.end(ROOT_END);

  provider.getTracer("some-other-instrumentation").startSpan("foreign", { attributes: linkAttributes }).end();
  tracer.startSpan("missing operation", { attributes: linkAttributes }).end();

  return { spans: memoryExporter.getFinishedSpans(), rootName: "invoke_agent chat", childName: "chat gpt-test" };
};

test(
  "the span exporter stores spans of our tracer as app and reports a rejected batch as FAILED",
  { skip: postgresTestSkip },
  async (): Promise<void> => {
    if (databaseUrlsMissing) {
      throw new Error(`${MISSING_DATABASE_URLS_MESSAGE}; CI=true forbids skipping this test`);
    }

    const fixture = createFixture();
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl });
    const exporter = new PostgresSpanExporter({ connectionString: appDatabaseUrl, ssl: false });

    try {
      await insertFixture(ownerPool, fixture);
      const { spans, rootName, childName } = recordSpans(fixture);
      const root = spans.find((span) => span.name === rootName);
      const child = spans.find((span) => span.name === childName);
      assert.ok(root !== undefined && child !== undefined);

      assert.equal((await exportSpans(exporter, spans)).code, ExportResultCode.SUCCESS);
      // A re-exported span is absorbed by ON CONFLICT instead of failing its batch.
      assert.equal((await exportSpans(exporter, spans)).code, ExportResultCode.SUCCESS);

      const rows = await readSpanRows(ownerPool, fixture.workspaceId);
      const expectedResourceAttributes = JSON.parse(JSON.stringify(root.resource.attributes));
      assert.deepEqual(
        rows,
        [
          {
            trace_id: root.spanContext().traceId,
            span_id: root.spanContext().spanId,
            parent_span_id: null,
            name: rootName,
            operation_name: "invoke_agent",
            status_code: "ok",
            status_message: null,
            start_micros: toMicros(ROOT_START),
            end_micros: toMicros(ROOT_END),
            user_id: fixture.userId,
            workspace_id: fixture.workspaceId,
            session_id: fixture.sessionId,
            attributes: { ...root.attributes },
            resource_attributes: expectedResourceAttributes,
          },
          {
            trace_id: root.spanContext().traceId,
            span_id: child.spanContext().spanId,
            parent_span_id: root.spanContext().spanId,
            name: childName,
            operation_name: "chat",
            status_code: "error",
            status_message: "model stream failed",
            start_micros: toMicros(CHILD_START),
            end_micros: toMicros(CHILD_END),
            user_id: fixture.userId,
            workspace_id: fixture.workspaceId,
            session_id: fixture.sessionId,
            attributes: { ...child.attributes },
            resource_attributes: expectedResourceAttributes,
          },
        ],
        "only the two complete spans of our tracer are stored, once each, with every column mapped",
      );

      const missingWorkspaceId = `span-exporter-missing-${randomUUID().replaceAll("-", "")}`;
      const rejected = await exportSpans(
        exporter,
        recordSpans({ ...fixture, workspaceId: missingWorkspaceId }).spans,
      );
      assert.equal(rejected.code, ExportResultCode.FAILED);
      assert.match(rejected.error?.message ?? "", /llm_telemetry_spans_workspace_id_fkey/);
      assert.deepEqual(await readSpanRows(ownerPool, missingWorkspaceId), []);

      // Deleting the chat session takes its spans with it.
      await ownerPool.query("DELETE FROM public.chat_sessions WHERE session_id = $1", [fixture.sessionId]);
      assert.deepEqual(await readSpanRows(ownerPool, fixture.workspaceId), []);
    } finally {
      try {
        await deleteFixture(ownerPool, fixture);
      } finally {
        await Promise.all([ownerPool.end(), exporter.shutdown()]);
      }
    }
  },
);
