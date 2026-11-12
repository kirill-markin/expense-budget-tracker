"use client";

import type { ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useChatLayout } from "./ChatLayoutProvider";
import styles from "../panel/ChatPanel.module.css";

type Props = Readonly<{
  buttonRef: RefObject<HTMLButtonElement | null>;
}>;

export const ChatToggle = ({ buttonRef }: Props): ReactElement => {
  const { t } = useTranslation();
  const { setIsOpen } = useChatLayout();

  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="chat-sidebar-open"
      className={styles.toggleFloating}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        setIsOpen(true);
      }}
    >
      {t("chat.title")}
    </button>
  );
};
