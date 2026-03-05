type ChatVendor = "anthropic" | "openai";
type ToolStatus = "started" | "completed" | "error";

type ChatEvent =
  | Readonly<{ domain: "chat"; action: "request"; vendor: ChatVendor; model: string; messageCount: number; hasAttachments: boolean }>
  | Readonly<{ domain: "chat"; action: "turn_start"; vendor: ChatVendor; turn: number }>
  | Readonly<{ domain: "chat"; action: "tool_call"; vendor: ChatVendor; tool: string; status: ToolStatus; durationMs?: number }>
  | Readonly<{ domain: "chat"; action: "response"; vendor: ChatVendor; turns: number; stopReason: string; durationMs: number }>
  | Readonly<{ domain: "chat"; action: "error"; vendor: ChatVendor; error: string }>;

type ApiEvent =
  | Readonly<{ domain: "api"; action: "error"; route: string; method: string; error: string }>;

type SqlApiEvent =
  | Readonly<{ domain: "sql-api"; action: "query"; durationMs: number; rowCount: number }>
  | Readonly<{ domain: "sql-api"; action: "error"; error: string }>;

type AuthEvent =
  | Readonly<{ domain: "auth"; action: "refresh" }>
  | Readonly<{ domain: "auth"; action: "proxy_auth_error"; error: string }>
  | Readonly<{ domain: "auth"; action: "error"; error: string }>;

type LogEvent = ChatEvent | ApiEvent | SqlApiEvent | AuthEvent;

export const log = (event: LogEvent): void => {
  console.log(JSON.stringify(event));
};
