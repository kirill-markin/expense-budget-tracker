import { CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import { buildSystemInstructions } from "@/server/chat/shared";

const CODE_INTERPRETER_OUTPUT_INCLUDE = ["code_interpreter_call.outputs"] as const;

export const buildOpenaiInstructions = (timezone: string, hasPersistentContainer: boolean): string =>
  buildSystemInstructions(timezone) +
  "\nYou also have a code interpreter for calculations, charts, or file analysis. Use it when appropriate." +
  "\nCSV attachments may already be injected into the conversation as raw text. Read that raw text directly instead of asking for a container file when it is available." +
  "\nIf the user attaches a PDF statement, use the code interpreter to parse it before claiming the file is unavailable." +
  "\nWhen you use the code interpreter for file analysis, make important results durable." +
  "\nFor small but important intermediate facts, print a compact text or JSON summary that can live in code interpreter logs." +
  "\nWhen parsing a PDF or similar statement with code interpreter, print the complete extracted transaction list in logs, not just a summary." +
  "\nImmediately after extracting raw transaction data from a PDF or similar statement, call capture_extracted_file_data with the same complete raw extracted data so it becomes a durable function_call_output item." +
  "\nDo not rely on raw Python variable values being preserved unless you emitted them as code interpreter logs or passed them into a follow-up tool call." +
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
