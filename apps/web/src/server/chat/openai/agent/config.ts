import { CHAT_MODEL_REASONING_EFFORT } from "@/lib/chatModels";
import { buildSystemInstructions } from "@/server/chat/shared";

const CODE_INTERPRETER_OUTPUT_INCLUDE = ["code_interpreter_call.outputs"] as const;

export const buildOpenaiInstructions = (timezone: string, hasPersistentContainer: boolean): string =>
  buildSystemInstructions(timezone) +
  "\nYou also have a code interpreter for calculations, charts, or file analysis. Use it when appropriate." +
  "\nIf the user attaches a CSV or spreadsheet file, inspect it with the code interpreter before claiming the file is unavailable." +
  (hasPersistentContainer
    ? "\nFiles previously attached earlier in this same chat remain available through code execution while the current code interpreter container is active."
    : "") +
  "\nYou also have web search. Use it to look up current exchange rates, financial news, tax rules, or any other real-time information.";

export const buildOpenAIModelSettings = (
  forcedToolChoice: "code_interpreter" | null,
): Readonly<Record<string, unknown>> => ({
  reasoning: { effort: CHAT_MODEL_REASONING_EFFORT },
  store: true,
  providerData: {
    extraBody: {
      include: CODE_INTERPRETER_OUTPUT_INCLUDE,
    },
  },
  ...(forcedToolChoice === null ? {} : { toolChoice: forcedToolChoice }),
});
