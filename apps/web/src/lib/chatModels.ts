export const CHAT_VENDOR = "openai" as const;
export const CHAT_MODEL_ID = "gpt-5.4" as const;
export const CHAT_MODEL_REASONING_EFFORT = "high" as const;
export const CHAT_MODEL_REASONING_SUMMARY = "auto" as const;
export const CHAT_MODEL_LABEL = "GPT-5.4" as const;
export const CHAT_PROVIDER_LABEL = "OpenAI" as const;
export const CHAT_MODEL_REASONING_LABEL = `${CHAT_MODEL_REASONING_EFFORT.slice(0, 1).toUpperCase()}${CHAT_MODEL_REASONING_EFFORT.slice(1)}` as const;
export const CHAT_MODEL_BADGE_LABEL = `${CHAT_MODEL_LABEL} · ${CHAT_MODEL_REASONING_LABEL}` as const;

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
