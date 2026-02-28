export type ChatModelDef = Readonly<{
  id: string;
  label: string;
  vendor: "openai";
}>;

export const CHAT_MODELS: ReadonlyArray<ChatModelDef> = [
  { id: "gpt-4.1", label: "GPT-4.1", vendor: "openai" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", vendor: "openai" },
  { id: "gpt-4.1-nano", label: "GPT-4.1 Nano", vendor: "openai" },
  { id: "gpt-5.2", label: "GPT-5.2", vendor: "openai" },
];

export const DEFAULT_MODEL_ID = "gpt-4.1-mini";
