"use client";

import type {
  KeyboardEvent,
  ReactElement,
  RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { CHAT_MODEL_BADGE_LABEL } from "@/lib/chatModels";
import type { ChatComposerAction } from "./streamRecovery";
import {
  FileAttachment,
  type PendingAttachment,
} from "./FileAttachment";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  inputText: string;
  pendingAttachments: ReadonlyArray<PendingAttachment>;
  composerAction: ChatComposerAction;
  isHistoryLoaded: boolean;
  isStopping: boolean;
  isLiveStreamConnected: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onAttach: (attachment: PendingAttachment) => void;
  onRemoveAttachment: (index: number) => void;
  onSend: () => Promise<void>;
  onStop: () => Promise<void>;
}>;

export const ChatComposer = (props: Props): ReactElement => {
  const {
    inputText,
    pendingAttachments,
    composerAction,
    isHistoryLoaded,
    isStopping,
    isLiveStreamConnected,
    textareaRef,
    onInputChange,
    onAttach,
    onRemoveAttachment,
    onSend,
    onStop,
  } = props;
  const { t } = useTranslation();

  const handleKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSend();
    }
  };

  const isSubmitButtonDisabled = !isHistoryLoaded
    || isStopping
    || (composerAction === "send" && isLiveStreamConnected);

  return (
    <div className={styles.inputArea}>
      {pendingAttachments.length > 0 && (
        <div className={styles.attachmentPreview}>
          {pendingAttachments.map((attachment, index) => (
            <span key={`${attachment.fileName}-${index}`} className={styles.attachmentChip}>
              {attachment.fileName}
              <button
                type="button"
                className={styles.attachmentRemove}
                onClick={() => onRemoveAttachment(index)}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        placeholder={t("chat.placeholder")}
        value={inputText}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
      />
      <div className={styles.controls}>
        <span className={styles.modelLabel}>{CHAT_MODEL_BADGE_LABEL}</span>
        <div className={styles.controlsRight}>
          <FileAttachment onAttach={onAttach} />
          <button
            type="button"
            className={styles.sendButton}
            disabled={isSubmitButtonDisabled}
            onClick={() => void (composerAction === "stop" ? onStop() : onSend())}
          >
            {composerAction === "stop" ? t("chat.stop") : t("chat.send")}
          </button>
        </div>
      </div>
    </div>
  );
};
