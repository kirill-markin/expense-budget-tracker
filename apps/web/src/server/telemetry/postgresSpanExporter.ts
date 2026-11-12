import { SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToTimeStamp, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_USER_ID,
} from "@opentelemetry/semantic-conventions/incubating";
import pg from "pg";
import type { DatabaseConnectionSettings } from "@/server/db/connectionSettings";
import { log } from "@/server/logger";
import { ATTR_APP_WORKSPACE_ID, TELEMETRY_TRACER_NAME } from "@/server/telemetry/tracer";

type SpanStatus = "unset" | "ok" | "error";

/** One llm_telemetry_spans row, keyed by column name for jsonb_to_recordset. */
type SpanRow = Readonly<{
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  operation_name: string;
  status_code: SpanStatus;
  status_message: string | null;
  start_time: string;
  end_time: string;
  user_id: string;
  workspace_id: string;
  session_id: string | null;
  attributes: Attributes;
  resource_attributes: Attributes;
}>;

type SpanRows = Readonly<{
  rows: ReadonlyArray<SpanRow>;
  skippedSpans: ReadonlyArray<Readonly<{ name: string; missingAttributes: ReadonlyArray<string> }>>;
}>;

const REQUIRED_SPAN_ATTRIBUTES = [ATTR_GEN_AI_OPERATION_NAME, ATTR_USER_ID, ATTR_APP_WORKSPACE_ID] as const;

const SPAN_STATUSES: Readonly<Record<SpanStatusCode, SpanStatus>> = {
  [SpanStatusCode.UNSET]: "unset",
  [SpanStatusCode.OK]: "ok",
  [SpanStatusCode.ERROR]: "error",
};

// One statement per batch. ON CONFLICT keeps a re-exported span from failing
// the batch it arrives in. It names no conflict target because inferring one
// needs SELECT on its columns, which app deliberately lacks; the primary key
// (trace_id, span_id) is the table's only unique index.
const INSERT_SPANS_SQL = `
  INSERT INTO public.llm_telemetry_spans (
    trace_id, span_id, parent_span_id, name, operation_name, status_code, status_message,
    start_time, end_time, user_id, workspace_id, session_id, attributes, resource_attributes
  )
  SELECT
    trace_id, span_id, parent_span_id, name, operation_name, status_code, status_message,
    start_time, end_time, user_id, workspace_id, session_id, attributes, resource_attributes
  FROM jsonb_to_recordset($1::jsonb) AS span(
    trace_id TEXT,
    span_id TEXT,
    parent_span_id TEXT,
    name TEXT,
    operation_name TEXT,
    status_code TEXT,
    status_message TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    user_id TEXT,
    workspace_id TEXT,
    session_id TEXT,
    attributes JSONB,
    resource_attributes JSONB
  )
  ON CONFLICT DO NOTHING
`;

const readStringAttribute = (attributes: Attributes, name: string): string | null => {
  const value = attributes[name];
  return typeof value === "string" && value !== "" ? value : null;
};

const toSpanRow = (span: ReadableSpan, operationName: string, userId: string, workspaceId: string): SpanRow => {
  const spanContext = span.spanContext();
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    parent_span_id: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    operation_name: operationName,
    status_code: SPAN_STATUSES[span.status.code],
    status_message: span.status.message ?? null,
    start_time: hrTimeToTimeStamp(span.startTime),
    end_time: hrTimeToTimeStamp(span.endTime),
    user_id: userId,
    workspace_id: workspaceId,
    session_id: readStringAttribute(span.attributes, ATTR_GEN_AI_CONVERSATION_ID),
    attributes: span.attributes,
    resource_attributes: span.resource.attributes,
  };
};

/**
 * Rows for the spans of our own tracer; spans of any other instrumentation are
 * not ours to store. A span of ours without its required attributes is a
 * programming error, reported as skipped rather than failing its batch.
 */
const toSpanRows = (spans: ReadonlyArray<ReadableSpan>): SpanRows =>
  spans
    .filter((span) => span.instrumentationScope.name === TELEMETRY_TRACER_NAME)
    .reduce<SpanRows>((result, span): SpanRows => {
      const operationName = readStringAttribute(span.attributes, ATTR_GEN_AI_OPERATION_NAME);
      const userId = readStringAttribute(span.attributes, ATTR_USER_ID);
      const workspaceId = readStringAttribute(span.attributes, ATTR_APP_WORKSPACE_ID);
      if (operationName === null || userId === null || workspaceId === null) {
        const missingAttributes = REQUIRED_SPAN_ATTRIBUTES.filter(
          (name) => readStringAttribute(span.attributes, name) === null,
        );
        return { ...result, skippedSpans: [...result.skippedSpans, { name: span.name, missingAttributes }] };
      }
      return { ...result, rows: [...result.rows, toSpanRow(span, operationName, userId, workspaceId)] };
    }, { rows: [], skippedSpans: [] });

/**
 * Stores spans of our own tracer in llm_telemetry_spans. It sits behind a
 * BatchSpanProcessor that only our tracer's spans reach, so chats never wait
 * for it, and it has its own small pool, so it never takes a connection a chat
 * needs. A failed batch is logged and reported to the processor, never thrown.
 */
export class PostgresSpanExporter implements SpanExporter {
  private readonly pool: pg.Pool;

  constructor(connection: DatabaseConnectionSettings) {
    this.pool = new pg.Pool({
      ...connection,
      max: 2,
      statement_timeout: 5_000,
      connectionTimeoutMillis: 5_000,
    });
    // An idle connection the server closes must not become an unhandled
    // 'error' event that terminates the process.
    this.pool.on("error", (error: Error): void => {
      log({ domain: "telemetry", action: "pool_error", error: error.message });
    });
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    void this.storeSpans(spans).then(resultCallback);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.pool.end();
  }

  private async storeSpans(spans: ReadonlyArray<ReadableSpan>): Promise<ExportResult> {
    let rowCount = 0;
    try {
      const { rows, skippedSpans } = toSpanRows(spans);
      rowCount = rows.length;
      if (skippedSpans.length > 0) {
        log({
          domain: "telemetry",
          action: "spans_skipped",
          spanCount: skippedSpans.length,
          missingAttributes: [...new Set(skippedSpans.flatMap((span) => span.missingAttributes))],
          spanNames: [...new Set(skippedSpans.map((span) => span.name))],
        });
      }
      if (rows.length > 0) {
        await this.pool.query(INSERT_SPANS_SQL, [JSON.stringify(rows)]);
      }
      return { code: ExportResultCode.SUCCESS };
    } catch (error: unknown) {
      const exportError = error instanceof Error ? error : new Error(String(error));
      log({
        domain: "telemetry",
        action: "span_export_failed",
        rowCount,
        error: exportError.message,
      });
      return { code: ExportResultCode.FAILED, error: exportError };
    }
  }
}
