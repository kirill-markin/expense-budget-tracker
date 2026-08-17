"use client";

import type {
  ChangeEvent,
  ClipboardEvent,
  KeyboardEvent,
  ReactElement,
  RefObject,
  SyntheticEvent,
} from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHAT_MODEL_BADGE_LABEL } from "@/lib/chatModels";
import {
  getBase64DecodedByteLength,
  getPdfDerivedImageByteLength,
} from "@/lib/chatPdf";
import type { PdfPreparationProgress } from "../../attachments/pdfPreprocessing";
import type { ChatComposerCapabilities } from "../../stream/display/chatComposerCapabilities";
import type { ChatDictationState } from "../../stream/hooks/chatDictation";
import type { ChatComposerAction } from "../../stream/streamRecovery";
import {
  AccountMentionPopover,
  ACCOUNT_MENTION_LISTBOX_ID,
  getAccountMentionOptionId,
} from "./AccountMentionPopover";
import {
  findAccountMentionTrigger,
  rankAccountSuggestions,
  replaceAccountMention,
  type AccountMentionSuggestion,
} from "./accountMentions";
import {
  FileAttachment,
  isAmbiguousClipboardFile,
  isSupportedClipboardImage,
  normalizeClipboardImageFile,
  type PendingAttachment,
} from "./FileAttachment";
import type { AccountSuggestionsState } from "./useAccountSuggestions";
import styles from "./ChatPanel.module.css";

export type AttachmentPreparationError = Readonly<{
  fileName: string;
  message: string;
}>;

export type DeferredAttachmentIngestion = () => Promise<void>;

const getPendingAttachmentDecodedByteLength = (
  attachment: PendingAttachment,
): number =>
  "base64Data" in attachment
    ? getBase64DecodedByteLength(attachment.base64Data)
    : getPdfDerivedImageByteLength(attachment);

type Props = Readonly<{
  inputText: string;
  pendingAttachments: ReadonlyArray<PendingAttachment>;
  attachmentErrors: ReadonlyArray<AttachmentPreparationError>;
  isAttachmentProcessing: boolean;
  attachmentProgress: PdfPreparationProgress | null;
  composerAction: ChatComposerAction;
  dictationState: ChatDictationState;
  dictationStatusLabel: string | null;
  capabilities: ChatComposerCapabilities;
  accountSuggestionsState: AccountSuggestionsState;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onIngestFiles: (files: ReadonlyArray<File>) => Promise<number>;
  onPrepareDeferredIngestion: (
    files: ReadonlyArray<File>,
  ) => DeferredAttachmentIngestion | null;
  onRemoveAttachment: (index: number) => void;
  onToggleDictation: () => Promise<void>;
  onSend: () => Promise<void>;
  onStop: () => Promise<void>;
}>;

export const ChatComposer = (props: Props): ReactElement => {
  const {
    inputText,
    pendingAttachments,
    attachmentErrors,
    isAttachmentProcessing,
    attachmentProgress,
    composerAction,
    dictationState,
    dictationStatusLabel,
    capabilities,
    accountSuggestionsState,
    textareaRef,
    onInputChange,
    onIngestFiles,
    onPrepareDeferredIngestion,
    onRemoveAttachment,
    onToggleDictation,
    onSend,
    onStop,
  } = props;
  const { t } = useTranslation();
  const [caretPosition, setCaretPosition] = useState<number>(inputText.length);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState<number | null>(null);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [maximumVisibleMentions, setMaximumVisibleMentions] = useState<number>(5);
  const pendingMentionCaretRef = useRef<number | null>(null);

  const boundedCaretPosition = Math.min(caretPosition, inputText.length);
  const activeMention = useMemo(
    () => findAccountMentionTrigger(inputText, boundedCaretPosition),
    [boundedCaretPosition, inputText],
  );
  const mentionKey = activeMention === null
    ? null
    : `${inputText}\u0000${boundedCaretPosition}\u0000${activeMention.start}:${activeMention.end}`;
  const visibleMentionSuggestions = useMemo(() => {
    if (activeMention === null || accountSuggestionsState.status !== "loaded") {
      return [];
    }
    return rankAccountSuggestions(
      accountSuggestionsState.suggestions,
      activeMention.query,
    ).slice(0, maximumVisibleMentions);
  }, [accountSuggestionsState, activeMention, maximumVisibleMentions]);
  const mentionSuggestionKey = visibleMentionSuggestions
    .map((suggestion) => `${suggestion.accountId}\u0000${suggestion.currency}`)
    .join("\u0001");
  const hasMentionPopoverContent = accountSuggestionsState.status !== "loaded"
    || visibleMentionSuggestions.length > 0;
  const isMentionPopoverOpen = activeMention !== null
    && mentionKey !== dismissedMentionKey
    && !capabilities.isTextareaDisabled
    && hasMentionPopoverContent;
  const activeDescendantId = isMentionPopoverOpen && selectedMentionIndex !== null
    ? getAccountMentionOptionId(selectedMentionIndex)
    : undefined;

  useEffect(() => {
    const mediaQueryList = window.matchMedia("(max-width: 768px)");
    const updateMaximumVisibleMentions = (): void => {
      setMaximumVisibleMentions(mediaQueryList.matches ? 4 : 5);
    };

    updateMaximumVisibleMentions();
    mediaQueryList.addEventListener("change", updateMaximumVisibleMentions);
    return () => mediaQueryList.removeEventListener("change", updateMaximumVisibleMentions);
  }, []);

  useEffect(() => {
    setSelectedMentionIndex(null);
  }, [mentionKey, mentionSuggestionKey]);

  useLayoutEffect(() => {
    const pendingCaretPosition = pendingMentionCaretRef.current;
    const textarea = textareaRef.current;
    if (
      pendingCaretPosition === null
      || textarea === null
      || textarea.value !== inputText
    ) {
      return;
    }

    textarea.focus();
    textarea.setSelectionRange(pendingCaretPosition, pendingCaretPosition);
    setCaretPosition(pendingCaretPosition);
    pendingMentionCaretRef.current = null;
  }, [inputText, textareaRef]);

  const microphoneAriaLabel = dictationState === "recording"
    ? t("chat.dictationStop")
    : t("chat.dictationStart");
  const enterKeyHint = capabilities.shouldSubmitOnEnter ? "send" : "enter";

  const selectMention = (suggestion: AccountMentionSuggestion): void => {
    if (activeMention === null) {
      return;
    }

    const replacement = replaceAccountMention(
      inputText,
      activeMention,
      suggestion.accountId,
    );
    pendingMentionCaretRef.current = replacement.caretPosition;
    setSelectedMentionIndex(null);
    setDismissedMentionKey(null);
    onInputChange(replacement.text);
  };

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setCaretPosition(event.currentTarget.selectionStart);
    setDismissedMentionKey(null);
    onInputChange(event.currentTarget.value);
  };

  const handleTextareaSelectionChange = (
    event: SyntheticEvent<HTMLTextAreaElement>,
  ): void => {
    setCaretPosition(event.currentTarget.selectionStart);
  };

  const handleTextareaKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (!event.nativeEvent.isComposing && isMentionPopoverOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMentionKey(mentionKey);
        setSelectedMentionIndex(null);
        return;
      }

      if (visibleMentionSuggestions.length > 0 && event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedMentionIndex((currentIndex) => (
          currentIndex === null
            ? 0
            : (currentIndex + 1) % visibleMentionSuggestions.length
        ));
        return;
      }

      if (visibleMentionSuggestions.length > 0 && event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedMentionIndex((currentIndex) => (
          currentIndex === null
            ? visibleMentionSuggestions.length - 1
            : (currentIndex - 1 + visibleMentionSuggestions.length)
              % visibleMentionSuggestions.length
        ));
        return;
      }

      if (
        event.key === "Enter"
        && !event.shiftKey
        && selectedMentionIndex !== null
      ) {
        const selectedSuggestion = visibleMentionSuggestions[selectedMentionIndex];
        if (selectedSuggestion !== undefined) {
          event.preventDefault();
          selectMention(selectedSuggestion);
          return;
        }
      }
    }

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
    const clipboardFileCandidates = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
      .filter((file: File): boolean =>
        isSupportedClipboardImage(file) || isAmbiguousClipboardFile(file));
    const shouldOwnPasteEvent = clipboardFileCandidates.some(isSupportedClipboardImage);
    const imageFiles = clipboardFileCandidates
      .map(normalizeClipboardImageFile);

    if (imageFiles.length === 0 || !capabilities.isDropTargetEnabled) {
      return;
    }

    if (shouldOwnPasteEvent) {
      event.preventDefault();
      void onIngestFiles(imageFiles);
      return;
    }

    const deferredIngestion = onPrepareDeferredIngestion(imageFiles);
    if (deferredIngestion === null) {
      return;
    }
    window.setTimeout((): void => {
      void deferredIngestion().catch((error: unknown): void => {
        window.setTimeout((): void => {
          throw error;
        }, 0);
      });
    }, 0);
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
            <span
              key={`${attachment.fileName}-${index}`}
              className={styles.attachmentChip}
              data-testid="chat-prepared-attachment"
              data-media-type={attachment.mediaType}
              data-encoded-size={getPendingAttachmentDecodedByteLength(attachment)}
            >
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
      {isAttachmentProcessing && (
        <div
          className={styles.attachmentProcessing}
          data-testid="chat-attachment-processing"
          role="status"
          aria-live="polite"
        >
          {attachmentProgress === null
            ? t("chat.attachmentProcessing")
            : t("chat.attachmentPdfProgress", {
              page: attachmentProgress.pageNumber,
              total: attachmentProgress.totalPages,
            })}
        </div>
      )}
      {attachmentErrors.length > 0 && (
        <div className={styles.attachmentErrors}>
          {attachmentErrors.map((error, index) => (
            <div
              key={`${error.fileName}-${index}`}
              className={styles.attachmentError}
              data-testid="chat-attachment-error"
              data-file-name={error.fileName}
              role="alert"
            >
              {error.message}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        data-testid="chat-composer-input"
        className={styles.textarea}
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={isMentionPopoverOpen}
        aria-controls={ACCOUNT_MENTION_LISTBOX_ID}
        aria-activedescendant={activeDescendantId}
        placeholder={t("chat.placeholder")}
        value={inputText}
        disabled={capabilities.isTextareaDisabled}
        enterKeyHint={enterKeyHint}
        onChange={handleTextareaChange}
        onClick={handleTextareaSelectionChange}
        onKeyDown={handleTextareaKeyDown}
        onSelect={handleTextareaSelectionChange}
        onPaste={handleTextareaPaste}
        rows={1}
      />
      <AccountMentionPopover
        isOpen={isMentionPopoverOpen}
        anchorRef={textareaRef}
        loadStatus={accountSuggestionsState.status}
        suggestions={visibleMentionSuggestions}
        selectedIndex={selectedMentionIndex}
        listLabel={t("chat.accountMentionsListLabel")}
        loadingLabel={t("chat.accountMentionsLoading")}
        unavailableLabel={t("chat.accountMentionsUnavailable")}
        onSelect={selectMention}
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
            data-testid="chat-dictation"
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
            data-testid="chat-submit"
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
