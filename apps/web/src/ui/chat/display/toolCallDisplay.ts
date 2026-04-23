import type { ToolCallContentPart } from "@/server/chat/types";

type Translate = (key: string) => string;

export type ToolCallDisplayState = Readonly<{
  label: string;
  statusLabel: string;
  input: string | null;
  output: string | null;
}>;

/**
 * Maps a normalized tool name to the localized label shown in the chat UI.
 *
 * The transcript stores provider-facing names, while the sidebar should use
 * stable user-facing labels where we already have translations.
 */
export const formatToolLabel = (
  name: string,
  t: Translate,
): string => {
  if (name === "query_database") return t("chat.toolDbQuery");
  if (name === "code_execution") return t("chat.toolCodeExec");
  if (name === "code_interpreter_call" || name === "code_interpreter") return t("chat.toolCodeInterpreter");
  if (name === "web_search_call" || name === "web_search") return t("chat.toolWebSearch");
  return name;
};

/**
 * Maps the provider status to the localized summary label shown beside a tool.
 *
 * The provider can report richer states than the transcript-level
 * `started/completed` flag, so the UI prefers the provider status when present.
 */
export const formatToolStatusLabel = (
  status: "started" | "completed",
  providerStatus: string | null | undefined,
  t: Translate,
): string => {
  const normalizedStatus = providerStatus ?? (status === "completed" ? "completed" : "running");
  if (normalizedStatus === "running") return t("chat.toolStatusRunning");
  if (normalizedStatus === "in_progress") return t("chat.toolStatusInProgress");
  if (normalizedStatus === "interpreting") return t("chat.toolStatusInterpreting");
  if (normalizedStatus === "searching") return t("chat.toolStatusSearching");
  if (normalizedStatus === "completed") return t("chat.toolStatusCompleted");
  if (normalizedStatus === "failed") return t("chat.toolStatusFailed");
  if (normalizedStatus === "incomplete") return t("chat.toolStatusIncomplete");
  return normalizedStatus.replaceAll("_", " ");
};

/**
 * Converts a stored structured payload into readable transcript text.
 *
 * Tool inputs and outputs are persisted as strings, often containing JSON.
 * This helper keeps scalars compact while pretty-printing arrays and objects.
 */
export const formatStructuredToolText = (
  value: string | null,
): string | null => {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === "string"
      || typeof parsed === "number"
      || typeof parsed === "boolean"
      || parsed === null
    ) {
      return String(parsed);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
};

/**
 * Formats the tool request body shown above the tool result.
 *
 * Database calls surface the SQL statement directly so the transcript stays
 * readable, while other tools keep their structured payload representation.
 */
export const formatToolInput = (
  name: string,
  input: string | null,
): string | null => {
  if (input === null) return null;
  if (name === "query_database") {
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      if (typeof parsed.sql === "string") return parsed.sql;
    } catch {
      // Preserve the original payload when it is not valid JSON.
    }
  }
  return formatStructuredToolText(input);
};

/**
 * Formats a terminal tool result for display in the transcript.
 *
 * Completed tools should expose their real output exactly as persisted, while
 * long payloads are truncated to keep the chat panel responsive.
 */
export const formatToolOutput = (
  name: string,
  output: string | null,
): string | null => {
  if (output === null) return null;
  let formattedOutput: string | null = output;
  if (name === "query_database") {
    try {
      const parsed = JSON.parse(output) as unknown;
      formattedOutput = JSON.stringify(parsed, null, 2);
    } catch {
      // Preserve the original payload when it is not valid JSON.
    }
  } else {
    formattedOutput = formatStructuredToolText(output);
  }
  return formattedOutput;
};

/**
 * Builds the fully formatted tool-call content shown inside a transcript item.
 *
 * The key policy is intentionally centralized here: while a tool call is still
 * non-terminal, the UI should show any known request but hide provider output
 * behind a simple `In progress` placeholder. This avoids rendering misleading
 * partial outputs such as empty arrays before the tool actually finishes.
 */
export const getToolCallDisplayState = (
  toolCall: ToolCallContentPart,
  t: Translate,
): ToolCallDisplayState => {
  const isTerminal = toolCall.status === "completed";

  return {
    label: formatToolLabel(toolCall.name, t),
    statusLabel: formatToolStatusLabel(toolCall.status, toolCall.providerStatus, t),
    input: formatToolInput(toolCall.name, toolCall.input),
    output: isTerminal
      ? formatToolOutput(toolCall.name, toolCall.output)
      : t("chat.toolStatusInProgress"),
  };
};
