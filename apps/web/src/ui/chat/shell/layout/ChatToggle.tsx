"use client";

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useChatLayout } from "./ChatLayoutProvider";
import styles from "../panel/ChatPanel.module.css";

export const ChatToggle = (): ReactElement => {
  const { t } = useTranslation();
  const { setIsOpen } = useChatLayout();

  return (
    <button
      type="button"
      data-testid="chat-sidebar-open"
      className={styles.toggleFloating}
      onClick={() => setIsOpen(true)}
    >
      {t("chat.title")}
    </button>
  );
};
