"use client";

import type { ReactElement } from "react";
import { CHAT_MODELS } from "@/lib/chatModels";

type Props = Readonly<{
  value: string;
  onChange: (modelId: string) => void;
}>;

export const ModelSelector = (props: Props): ReactElement => {
  const { value, onChange } = props;

  return (
    <select
      className="chat-model-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {CHAT_MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
};
