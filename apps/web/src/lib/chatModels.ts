export const CHAT_VENDOR = "openai" as const;
export const CHAT_MODEL_ID = "gpt-6.1-sol" as const;
export const CHAT_MODEL_REASONING_EFFORT = "medium" as const;
export const CHAT_FALLBACK_MODEL_ID = "gpt-6-luna" as const;
export const CHAT_FALLBACK_MODEL_REASONING_EFFORT = "max" as const;
export const CHAT_MODEL_REASONING_SUMMARY = "auto" as const;
/**
 * Input-token threshold handed to OpenAI server-side compaction. A call whose
 * input exceeds it is answered with a compaction item standing for the context
 * it absorbed, which later calls replay instead of the turns themselves.
 */
export const CHAT_COMPACT_THRESHOLD_TOKENS = 80_000;
export const CHAT_MODEL_LABEL = "GPT-6.1 Sol" as const;
export const CHAT_PROVIDER_LABEL = "OpenAI" as const;
export const CHAT_MODEL_REASONING_LABEL = `${CHAT_MODEL_REASONING_EFFORT.slice(0, 1).toUpperCase()}${CHAT_MODEL_REASONING_EFFORT.slice(1)}` as const;
export const CHAT_MODEL_BADGE_LABEL = `${CHAT_MODEL_LABEL} · ${CHAT_MODEL_REASONING_LABEL}` as const;

export type ChatEffectiveModelId =
  | typeof CHAT_MODEL_ID
  | typeof CHAT_FALLBACK_MODEL_ID;

export type ChatEffectiveReasoningEffort =
  | typeof CHAT_MODEL_REASONING_EFFORT
  | typeof CHAT_FALLBACK_MODEL_REASONING_EFFORT;

export type ChatModelDef = Readonly<{
  id: typeof CHAT_MODEL_ID;
  label: typeof CHAT_MODEL_LABEL;
  vendor: typeof CHAT_VENDOR;
}>;

export const CHAT_MODEL: ChatModelDef = {
  id: CHAT_MODEL_ID,
  label: CHAT_MODEL_LABEL,
  vendor: CHAT_VENDOR,
};
