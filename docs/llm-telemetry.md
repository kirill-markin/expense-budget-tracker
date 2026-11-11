# LLM Telemetry

The web app records every chat turn and voice transcription as OpenTelemetry spans named by the GenAI semantic conventions, and stores them in its own Postgres table `llm_telemetry_spans` ([migration 0088](../db/migrations/0088_llm_telemetry_spans.sql)). No third-party service receives them unless an OTLP endpoint is configured.

## Span tree

- `invoke_agent web_chat` — root of one web-chat turn, a new trace per turn
  - `chat <model>` — one per OpenAI model call attempt, so a retried call has several
  - `execute_tool <tool>` — one per local tool call, such as `execute_tool sql_query`
- `transcribe <model>` — root of one voice transcription, its own trace

## Table

| Column | Holds |
| --- | --- |
| `trace_id`, `span_id`, `parent_span_id` | the tree above; `parent_span_id` is null on a root |
| `name`, `operation_name` | span name and `gen_ai.operation.name`: `invoke_agent`, `chat`, `execute_tool`, `transcribe` |
| `status_code`, `status_message` | `unset`, `ok` or `error`; the message is an error class name or our own error code, never free error text |
| `start_time`, `end_time` | span timing |
| `user_id`, `workspace_id`, `session_id` | who and where; `session_id` is the chat session, always null on a transcription span |
| `attributes` | every span attribute, keyed by its OpenTelemetry name |
| `resource_attributes` | `service.name` and the other attributes of the exporting process |

Main attributes:

- GenAI: `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.reasoning.output_tokens`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.conversation.id`, `error.type`
- App: `app.workspace_id`, `app.request_id` (matches `requestId` in the web logs), `app.turn_id`, `app.assistant_item_id`, `app.turn.outcome`, `app.call_index`, `app.attempt`, `app.openai.usage` (the whole OpenAI usage object as JSON), `app.system_instructions_sha256`, `app.tool.error_code`, `app.tool.mutating`

The constants are in [`apps/web/src/server/telemetry/tracer.ts`](../apps/web/src/server/telemetry/tracer.ts) and [`chatSpans.ts`](../apps/web/src/server/telemetry/chatSpans.ts).

## Link to chats

Spans hold ids and numbers only, never message content, tool arguments or tool output. The transcript stays in `chat_items`: join on `session_id`, and `app.assistant_item_id` is the `chat_items.item_id` of the turn's assistant reply. `app.turn_id` is the chat run id the turn ran under, and `app.system_instructions_sha256` identifies the system prompt the model call used. Rows go away with their workspace or chat session through `ON DELETE CASCADE`.

## Writing

A batch span processor exports spans every 5 seconds through its own two-connection pool, so a chat never waits for telemetry and never loses a connection to it. A full queue drops new spans; a failed batch is logged as `span_export_failed` and dropped. The web role `app` may insert rows and read none.

## Reading

Production rows are read through the private admin-reader Lambda with [`scripts/admin-read.sh`](../scripts/admin-read.sh); see [admin-reader.md](admin-reader.md). Locally, run `make dev` and query the table with `psql "$MIGRATION_DATABASE_URL"` (the owner role `tracker` from `.env.example`), since `app` cannot read it.

## Optional OTLP export

Setting `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` on the web service also sends the same spans to that OTLP/HTTP collector, and no Next.js request spans; `OTEL_EXPORTER_OTLP_HEADERS` carries its authentication, and the exporter reads the other standard `OTEL_EXPORTER_OTLP_*` settings itself. The Postgres table is written either way. The AWS stack sets no OTLP endpoint; the Docker compose files pass `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` through.
