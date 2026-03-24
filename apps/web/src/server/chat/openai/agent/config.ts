import { CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import { buildSystemInstructions } from "@/server/chat/shared";

const CODE_INTERPRETER_OUTPUT_INCLUDE = ["code_interpreter_call.outputs"] as const;

export const buildOpenaiInstructions = (timezone: string, hasPersistentContainer: boolean): string =>
  buildSystemInstructions(timezone) +
  "\nYou also have a code interpreter, but treat it as a secondary analysis tool for calculations, statistics, cleanup, verification, or ad hoc transformations." +
  "\nFor CSV, XLS, and XLSX attachments, prefer the raw tabular text already injected into the conversation when it is available." +
  "\nThe original attached files also remain available as files, including for code interpreter use when needed." +
  "\nFor PDF attachments, prefer the native file context first. Use code interpreter only when you actually need extraction cleanup, verification against the original file, calculations, statistics, or transformations." +
  "\nWhen you use the code interpreter for file analysis, make important results durable." +
  "\nFor small but important intermediate facts, print a compact text or JSON summary that can live in code interpreter logs." +
  "\nIf code interpreter extracts transaction-like rows or raw structured data that will matter for later tool calls, print the complete extracted rows in logs." +
  "\nDo not rely on container memory or raw Python variable values being preserved unless you emitted them as code interpreter logs or passed them into a follow-up tool call." +
  "\nIf a custom function tool encounters an expected validation or execution error, return a structured error payload as the tool result instead of throwing." +
  (hasPersistentContainer
    ? "\nFiles previously attached earlier in this same chat remain available through code execution while the current code interpreter container is active."
    : "") +
  "\nYou also have web search. Use it to look up current exchange rates, financial news, tax rules, or any other real-time information.";

/**
 * Builds the model settings for the browser chat's OpenAI-managed conversation flow.
 * `store: true` is enabled because the app relies on OpenAI conversation state between turns,
 * while still keeping the full chat transcript in Postgres as the product source of truth.
 */
export const buildOpenAIModelSettings = (
  forcedToolChoice: "code_interpreter" | null,
): Readonly<Record<string, unknown>> => ({
  reasoning: { effort: CHAT_MODEL_REASONING_EFFORT, summary: "auto" },
  store: true,
  providerData: {
    extraBody: {
      include: CODE_INTERPRETER_OUTPUT_INCLUDE,
    },
  },
  ...(forcedToolChoice === null ? {} : { toolChoice: forcedToolChoice }),
});
