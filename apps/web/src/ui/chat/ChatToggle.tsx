"use client";

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useChatLayout } from "./ChatLayoutProvider";

export const ChatToggle = (): ReactElement => {
  const { t } = useTranslation();
  const { setIsOpen } = useChatLayout();

  return (
    <button
      type="button"
      className="chat-toggle-floating"
      onClick={() => setIsOpen(true)}
    >
      {t("chat.title")}
    </button>
  );
};
