"use client";

import type {
  ClipboardEvent,
  KeyboardEvent,
  ReactElement,
  RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { CHAT_MODEL_BADGE_LABEL } from "@/lib/chatModels";
import type { ChatComposerCapabilities } from "../../stream/display/chatComposerCapabilities";
import type { ChatDictationState } from "../../stream/hooks/chatDictation";
import type { ChatComposerAction } from "../../stream/streamRecovery";
import {
  FileAttachment,
  type PendingAttachment,
} from "./FileAttachment";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  inputText: string;
  pendingAttachments: ReadonlyArray<PendingAttachment>;
  composerAction: ChatComposerAction;
  dictationState: ChatDictationState;
  dictationStatusLabel: string | null;
  capabilities: ChatComposerCapabilities;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onIngestFiles: (files: ReadonlyArray<File>) => Promise<number>;
  onRemoveAttachment: (index: number) => void;
  onToggleDictation: () => Promise<void>;
  onSend: () => Promise<void>;
  onStop: () => Promise<void>;
}>;

export const ChatComposer = (props: Props): ReactElement => {
  const {
    inputText,
    pendingAttachments,
    composerAction,
    dictationState,
    dictationStatusLabel,
    capabilities,
    textareaRef,
    onInputChange,
    onIngestFiles,
    onRemoveAttachment,
    onToggleDictation,
    onSend,
    onStop,
  } = props;
  const { t } = useTranslation();

  const microphoneAriaLabel = dictationState === "recording"
    ? t("chat.dictationStop")
    : t("chat.dictationStart");
  const enterKeyHint = capabilities.shouldSubmitOnEnter ? "send" : "enter";

  const handleTextareaKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key !== "Enter") {
      return;
    }

    if (event.shiftKey || event.nativeEvent.isComposing || !capabilities.isEnterSubmissionEnabled) {
      return;
    }

    event.preventDefault();
    void onSend();
  };

  const handleTextareaPaste = (
    event: ClipboardEvent<HTMLTextAreaElement>,
  ): void => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
      .map((file) => file.name === ""
        ? new File([file], "clipboard-image.png", {
          type: file.type,
          lastModified: file.lastModified,
        })
        : file);

    if (imageFiles.length === 0 || !capabilities.isDropTargetEnabled) {
      return;
    }

    event.preventDefault();
    void onIngestFiles(imageFiles);
  };

  const handleSubmitButtonClick = (): void => {
    if (composerAction === "stop") {
      void onStop();
      return;
    }

    textareaRef.current?.focus();
    void onSend();
  };

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
        data-testid="chat-composer-input"
        className={styles.textarea}
        placeholder={t("chat.placeholder")}
        value={inputText}
        disabled={capabilities.isTextareaDisabled}
        enterKeyHint={enterKeyHint}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={handleTextareaKeyDown}
        onPaste={handleTextareaPaste}
        rows={1}
      />
      {dictationStatusLabel !== null && (
        <div className={styles.dictationStatus} aria-live="polite">
          {dictationStatusLabel}
        </div>
      )}
      <div className={styles.controls}>
        <span className={styles.modelLabel}>{CHAT_MODEL_BADGE_LABEL}</span>
        <div className={styles.controlsRight}>
          <button
            type="button"
            className={styles.microphoneButton}
            disabled={capabilities.isMicrophoneButtonDisabled}
            aria-label={microphoneAriaLabel}
            aria-pressed={dictationState === "recording"}
            onClick={() => void onToggleDictation()}
          >
            <svg
              className={styles.microphoneIcon}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              {dictationState === "recording" ? (
                <rect x="7" y="7" width="10" height="10" rx="2" />
              ) : (
                <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 1 0 10 0Z" />
              )}
            </svg>
          </button>
          <FileAttachment
            onIngestFiles={onIngestFiles}
            disabled={capabilities.isAttachButtonDisabled}
          />
          <button
            type="button"
            className={styles.sendButton}
            disabled={capabilities.isSubmitButtonDisabled}
            onClick={handleSubmitButtonClick}
          >
            {composerAction === "stop" ? t("chat.stop") : t("chat.send")}
          </button>
        </div>
      </div>
    </div>
  );
};
