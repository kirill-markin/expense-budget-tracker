"use client";

import type { ReactElement } from "react";
import { CHAT_MODELS, type ChatModelVendor } from "@/lib/chatModels";

type Props = Readonly<{
  value: string;
  onChange: (modelId: string) => void;
  disabled: boolean;
}>;

const VENDOR_LABELS: Record<ChatModelVendor, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

const VENDOR_ORDER: ReadonlyArray<ChatModelVendor> = ["anthropic", "openai"];

export const ModelSelector = (props: Props): ReactElement => {
  const { value, onChange, disabled } = props;

  return (
    <select
      className="chat-model-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {VENDOR_ORDER.map((vendor) => {
        const models = CHAT_MODELS.filter((m) => m.vendor === vendor);
        if (models.length === 0) return null;
        return (
          <optgroup key={vendor} label={VENDOR_LABELS[vendor]}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
};
