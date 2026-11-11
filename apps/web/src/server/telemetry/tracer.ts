import { trace, type Tracer } from "@opentelemetry/api";

/** Spans of this tracer, and only these, are stored in llm_telemetry_spans. */
export const TELEMETRY_TRACER_NAME = "expense-budget-tracker.web";

/** App-specific span attributes that link a span to rows of our own tables. */
export const ATTR_APP_WORKSPACE_ID = "app.workspace_id";
export const ATTR_APP_REQUEST_ID = "app.request_id";
export const ATTR_APP_TURN_ID = "app.turn_id";
export const ATTR_APP_ASSISTANT_ITEM_ID = "app.assistant_item_id";
export const ATTR_APP_REASONING_EFFORT = "app.reasoning_effort";
export const ATTR_APP_TURN_INDEX = "app.turn_index";
export const ATTR_APP_TURN_OUTCOME = "app.turn.outcome";
export const ATTR_APP_CALL_INDEX = "app.call_index";
export const ATTR_APP_ATTEMPT = "app.attempt";
export const ATTR_APP_SYSTEM_INSTRUCTIONS_SHA256 = "app.system_instructions_sha256";
export const ATTR_APP_REPLAYED_MESSAGES = "app.replayed_messages";
export const ATTR_APP_TIMEOUT_LIMIT = "app.timeout.limit";
export const ATTR_APP_OPENAI_USAGE = "app.openai.usage";
export const ATTR_APP_RESPONSE_OUTPUT_ITEMS = "app.response.output_items";
export const ATTR_APP_RESPONSE_COMPACTION_ITEMS = "app.response.compaction_items";
export const ATTR_APP_RESPONSE_ENCRYPTED_CONTENT_CHARS = "app.response.encrypted_content_chars";
export const ATTR_APP_TOOL_ERROR_CODE = "app.tool.error_code";
export const ATTR_APP_TOOL_MUTATING = "app.tool.mutating";
export const ATTR_APP_AUDIO_MEDIA_TYPE = "app.audio.media_type";
export const ATTR_APP_AUDIO_BYTES = "app.audio.bytes";
export const ATTR_APP_TRANSCRIPTION_CHARS = "app.transcription.chars";

export const getTelemetryTracer = (): Tracer => trace.getTracer(TELEMETRY_TRACER_NAME);
