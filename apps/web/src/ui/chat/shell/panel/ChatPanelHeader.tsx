"use client";

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  mode: "sidebar" | "fullscreen";
  transcriptActionsDisabled: boolean;
  copyButtonLabel: string;
  onCopyTranscript: () => void;
  onClearConversation: () => void;
  onCloseSidebar: () => void;
}>;

export const ChatPanelHeader = (props: Props): ReactElement => {
  const {
    mode,
    transcriptActionsDisabled,
    copyButtonLabel,
    onCopyTranscript,
    onClearConversation,
    onCloseSidebar,
  } = props;
  const { t } = useTranslation();

  return (
    <div className={styles.header}>
      <span className={styles.headerTitle}>{t("chat.title")}</span>
      <div className={styles.headerActions}>
        <button
          type="button"
          className={`${styles.closeButton} ${styles.copyButton}`}
          onClick={onCopyTranscript}
          disabled={transcriptActionsDisabled}
          aria-label={copyButtonLabel}
          title={copyButtonLabel}
        >
          <svg
            className={styles.copyButtonIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClearConversation}
          disabled={transcriptActionsDisabled}
        >
          {t("chat.new")}
        </button>
        {mode === "sidebar" && (
          <button
            type="button"
            data-testid="chat-sidebar-close"
            className={styles.closeButton}
            onClick={onCloseSidebar}
          >
            &laquo;
          </button>
        )}
      </div>
    </div>
  );
};
