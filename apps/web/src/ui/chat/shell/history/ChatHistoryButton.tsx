"use client";

import type { ReactElement, RefObject } from "react";
import { useTranslation } from "react-i18next";

import styles from "./ChatHistoryDialog.module.css";

type Props = Readonly<{
  open: boolean;
  dialogId: string;
  runningCount: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
}>;

export const ChatHistoryButton = (props: Props): ReactElement => {
  const {
    open,
    dialogId,
    runningCount,
    buttonRef,
    onOpenChange,
  } = props;
  const { t } = useTranslation();
  const accessibleLabel = runningCount > 0
    ? t("chat.historyOpenRunning", { count: runningCount })
    : t("chat.historyOpen");

  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.historyButton}
      data-testid="chat-history-open"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={dialogId}
      onClick={() => onOpenChange(!open)}
    >
      <svg
        className={styles.historyButtonIcon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M9 6h11" />
        <path d="M9 12h11" />
        <path d="M9 18h11" />
        <path d="M4 6h.01" />
        <path d="M4 12h.01" />
        <path d="M4 18h.01" />
      </svg>
      {runningCount > 0 && (
        <span className={styles.runningBadge} data-testid="chat-history-running-count" aria-hidden="true">
          {runningCount}
        </span>
      )}
    </button>
  );
};
