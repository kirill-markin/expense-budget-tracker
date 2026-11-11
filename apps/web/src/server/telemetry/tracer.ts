import { trace, type Tracer } from "@opentelemetry/api";

/** Spans of this tracer, and only these, are stored in llm_telemetry_spans. */
export const TELEMETRY_TRACER_NAME = "expense-budget-tracker.web";

/** App-specific span attributes that link a span to rows of our own tables. */
export const ATTR_APP_WORKSPACE_ID = "app.workspace_id";
export const ATTR_APP_REQUEST_ID = "app.request_id";
export const ATTR_APP_TURN_ID = "app.turn_id";
export const ATTR_APP_ASSISTANT_ITEM_ID = "app.assistant_item_id";

export const getTelemetryTracer = (): Tracer => trace.getTracer(TELEMETRY_TRACER_NAME);
