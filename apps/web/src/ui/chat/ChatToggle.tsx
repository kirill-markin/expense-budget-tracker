"use client";

import type { ReactElement } from "react";
import { useChatLayout } from "./ChatLayoutProvider";

export const ChatToggle = (): ReactElement => {
  const { setIsOpen } = useChatLayout();

  return (
    <button
      type="button"
      className="chat-toggle-floating"
      onClick={() => setIsOpen(true)}
    >
      AI Chat
    </button>
  );
};
