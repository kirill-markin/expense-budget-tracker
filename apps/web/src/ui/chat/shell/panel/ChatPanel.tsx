"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type DragEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/cn";
import { useChatLayout } from "../layout/ChatLayoutProvider";
import {
  ChatComposer,
  type AttachmentPreparationError,
} from "./ChatComposer";
import { ChatPanelHeader } from "./ChatPanelHeader";
import { ChatTranscript } from "./ChatTranscript";
import { prepareAttachment, type PendingAttachment } from "./FileAttachment";
import {
  getAttachmentFailureReasonKey,
  startMountedLifecycle,
} from "./chatPanelRuntime";
import { getChatComposerCapabilities } from "../../stream/display/chatComposerCapabilities";
import { buildChatTranscriptMarkdown } from "../../stream/display/chatTranscriptMarkdown";
import {
  insertDictationTranscriptIntoDraft,
  transcribeChatAudio,
  type ChatDraftSelection,
  type ChatDictationState,
} from "../../stream/hooks/chatDictation";
import { useDesktopEnterToSend } from "../../stream/hooks/useDesktopEnterToSend";
import { useChatSessionController } from "../../session/controller/useChatSessionController";
import styles from "./ChatPanel.module.css";

type Props = Readonly<{
  mode: "sidebar" | "fullscreen";
  workspaceId: string;
}>;

type CopyStatus = "idle" | "success" | "error";

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;

const stopMediaStream = (stream: MediaStream | null): void => {
  if (stream === null) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
};

const chooseSupportedRecordingMimeType = (): string | null => {
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }

  const supportedMimeTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];

  for (const mimeType of supportedMimeTypes) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return null;
};

const cleanupDictationResources = (
  mediaRecorderRef: MutableRefObject<MediaRecorder | null>,
  mediaStreamRef: MutableRefObject<MediaStream | null>,
  recordedChunksRef: MutableRefObject<Array<Blob>>,
): void => {
  stopMediaStream(mediaStreamRef.current);
  mediaRecorderRef.current = null;
  mediaStreamRef.current = null;
  recordedChunksRef.current = [];
};

const stopMediaRecorder = (
  recorder: MediaRecorder,
  recordedChunksRef: MutableRefObject<Array<Blob>>,
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const handleStop = (): void => {
      recorder.removeEventListener("error", handleError as EventListener);
      resolve(new Blob(recordedChunksRef.current, {
        type: recorder.mimeType === "" ? "audio/webm" : recorder.mimeType,
      }));
    };

    const handleError = (event: Event): void => {
      recorder.removeEventListener("stop", handleStop);
      if (event instanceof ErrorEvent && event.error instanceof Error) {
        reject(event.error);
        return;
      }

      reject(new Error("Microphone recording failed."));
    };

    recorder.addEventListener("stop", handleStop, { once: true });
    recorder.addEventListener("error", handleError as EventListener, { once: true });
    recorder.stop();
  });

const getMicrophoneErrorMessage = (
  error: unknown,
  t: (key: string) => string,
): string => {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return t("chat.dictationPermissionDenied");
  }

  if (error instanceof DOMException && error.name === "NotFoundError") {
    return t("chat.dictationNoMicrophone");
  }

  return error instanceof Error ? error.message : String(error);
};

export const ChatPanel = (props: Props): ReactElement => {
  const { mode, workspaceId } = props;
  const { t } = useTranslation();
  const {
    setIsOpen,
    chatWidth,
    setChatWidth,
    chatDraftText: inputText,
    setChatDraftText: setInputText,
  } = useChatLayout();
  const {
    messages,
    runState,
    isHistoryLoaded,
    isAssistantRunActive,
    isLiveStreamConnected,
    isStopping,
    composerAction,
    acceptServerSessionId,
    ensureWritableSessionId,
    sendMessage,
    stopMessage,
    clearConversation,
  } = useChatSessionController({ mode, workspaceId });

  const [localWidth, setLocalWidth] = useState<number>(chatWidth);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [pendingAttachments, setPendingAttachments] = useState<ReadonlyArray<PendingAttachment>>([]);
  const [attachmentErrors, setAttachmentErrors] = useState<ReadonlyArray<AttachmentPreparationError>>([]);
  const [isAttachmentProcessing, setIsAttachmentProcessing] = useState<boolean>(false);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [dictationState, setDictationState] = useState<ChatDictationState>("idle");
  const shouldSubmitOnEnter = useDesktopEnterToSend();

  const dragCounterRef = useRef<number>(0);
  const isAttachmentProcessingRef = useRef<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const copyStatusResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Array<Blob>>([]);
  const draftSelectionRef = useRef<ChatDraftSelection | null>(null);
  const pendingTextareaSelectionRef = useRef<ChatDraftSelection | null>(null);
  const shouldRestoreTextareaFocusAfterDictationRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent): void => {
      const isRtl = document.documentElement.dir === "rtl";
      const rawWidth = isRtl ? window.innerWidth - e.clientX : e.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(rawWidth, MAX_WIDTH));
      setLocalWidth(newWidth);
    };

    const handleMouseUp = (): void => {
      setIsDragging(false);
      setChatWidth(localWidth);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isDragging, localWidth, setChatWidth]);

  useEffect(() => {
    const finishMountedLifecycle = startMountedLifecycle(isMountedRef);

    return () => {
      finishMountedLifecycle();
      if (copyStatusResetRef.current !== null) {
        clearTimeout(copyStatusResetRef.current);
      }
      const recorder = mediaRecorderRef.current;
      if (recorder !== null && recorder.state !== "inactive") {
        recorder.stop();
      }
      cleanupDictationResources(mediaRecorderRef, mediaStreamRef, recordedChunksRef);
    };
  }, []);

  useEffect(() => {
    if (dictationState !== "idle") {
      return;
    }

    const textarea = textareaRef.current;
    const pendingSelection = pendingTextareaSelectionRef.current;
    if (textarea === null || pendingSelection === null) {
      return;
    }

    const start = Math.max(0, Math.min(pendingSelection.start, textarea.value.length));
    const end = Math.max(0, Math.min(pendingSelection.end, textarea.value.length));

    if (shouldRestoreTextareaFocusAfterDictationRef.current) {
      textarea.focus();
    }

    textarea.setSelectionRange(start, end);
    draftSelectionRef.current = { start, end };
    pendingTextareaSelectionRef.current = null;
    shouldRestoreTextareaFocusAfterDictationRef.current = false;
  }, [dictationState, inputText]);

  const ingestFiles = useCallback(async (files: ReadonlyArray<File>): Promise<number> => {
    if (files.length === 0 || isAttachmentProcessingRef.current) {
      return 0;
    }

    isAttachmentProcessingRef.current = true;
    setIsAttachmentProcessing(true);
    setAttachmentErrors([]);
    let attachedFileCount = 0;

    try {
      for (const file of files) {
        try {
          const attachment = await prepareAttachment(file);
          if (isMountedRef.current) {
            setPendingAttachments((prev) => [...prev, attachment]);
          }
          attachedFileCount += 1;
        } catch (error) {
          const reason = t(getAttachmentFailureReasonKey(error));
          if (isMountedRef.current) {
            setAttachmentErrors((previousErrors) => [
              ...previousErrors,
              {
                fileName: file.name,
                message: t("chat.attachmentConversionFailed", {
                  fileName: file.name,
                  reason,
                }),
              },
            ]);
          }
        }
      }
    } finally {
      isAttachmentProcessingRef.current = false;
      if (isMountedRef.current) {
        setIsAttachmentProcessing(false);
      }
    }

    return attachedFileCount;
  }, [t]);

  const removeAttachment = useCallback((index: number): void => {
    setPendingAttachments((prev) => [...prev.slice(0, index), ...prev.slice(index + 1)]);
  }, []);

  const hasPendingMessage = inputText.trim().length > 0 || pendingAttachments.length > 0;
  const composerCapabilities = getChatComposerCapabilities({
    composerAction,
    isHistoryLoaded,
    isStopping,
    isLiveStreamConnected,
    isAttachmentProcessing,
    dictationState,
    hasPendingMessage,
    shouldSubmitOnEnter,
  });

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();

    if (!composerCapabilities.isDropTargetEnabled) {
      return;
    }
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, [composerCapabilities.isDropTargetEnabled]);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();

    if (!composerCapabilities.isDropTargetEnabled) {
      return;
    }
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, [composerCapabilities.isDropTargetEnabled]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();

    if (!composerCapabilities.isDropTargetEnabled) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.dataTransfer.dropEffect = "copy";
  }, [composerCapabilities.isDropTargetEnabled]);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (!composerCapabilities.isDropTargetEnabled) {
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    const attachedFileCount = await ingestFiles(files);

    if (attachedFileCount > 0) {
      textareaRef.current?.focus();
    }
  }, [composerCapabilities.isDropTargetEnabled, ingestFiles]);

  const canSendPendingMessage = isHistoryLoaded
    && !isStopping
    && !isAssistantRunActive
    && !isLiveStreamConnected
    && !isAttachmentProcessing
    && dictationState === "idle"
    && hasPendingMessage;

  useEffect(() => {
    if (composerCapabilities.isDropTargetEnabled) {
      return;
    }

    dragCounterRef.current = 0;
    setIsDragOver(false);
  }, [composerCapabilities.isDropTargetEnabled]);

  const discardDictation = useCallback((): void => {
    const recorder = mediaRecorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") {
      recorder.stop();
    }

    cleanupDictationResources(mediaRecorderRef, mediaStreamRef, recordedChunksRef);
    draftSelectionRef.current = null;
    pendingTextareaSelectionRef.current = null;
    shouldRestoreTextareaFocusAfterDictationRef.current = false;
    if (isMountedRef.current) {
      setDictationState("idle");
    }
  }, []);

  const startDictation = useCallback(async (): Promise<void> => {
    if (dictationState !== "idle") {
      return;
    }

    const textarea = textareaRef.current;
    const shouldRestoreFocus = textarea !== null && document.activeElement === textarea;
    shouldRestoreTextareaFocusAfterDictationRef.current = shouldRestoreFocus;
    draftSelectionRef.current = shouldRestoreFocus && textarea !== null
      ? {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      }
      : null;

    if (typeof MediaRecorder === "undefined") {
      alert(t("chat.dictationUnavailable"));
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== "function") {
      alert(t("chat.dictationUnavailable"));
      return;
    }

    setDictationState("requesting_permission");

    let stream: MediaStream | null = null;
    try {
      stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      const recorderMimeType = chooseSupportedRecordingMimeType();
      const recorder = recorderMimeType === null
        ? new MediaRecorder(stream)
        : new MediaRecorder(stream, { mimeType: recorderMimeType });
      recordedChunksRef.current = [];
      recorder.addEventListener("dataavailable", (event: BlobEvent) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      });
      recorder.start();
      mediaRecorderRef.current = recorder;
      mediaStreamRef.current = stream;
      if (isMountedRef.current) {
        setDictationState("recording");
      }
    } catch (error) {
      stopMediaStream(stream);
      cleanupDictationResources(mediaRecorderRef, mediaStreamRef, recordedChunksRef);
      if (isMountedRef.current) {
        alert(getMicrophoneErrorMessage(error, t));
        setDictationState("idle");
      }
    }
  }, [dictationState, t]);

  const stopDictation = useCallback(async (): Promise<void> => {
    const recorder = mediaRecorderRef.current;
    if (recorder === null || recorder.state === "inactive") {
      cleanupDictationResources(mediaRecorderRef, mediaStreamRef, recordedChunksRef);
      setDictationState("idle");
      return;
    }

    setDictationState("transcribing");

    try {
      const audioBlob = await stopMediaRecorder(recorder, recordedChunksRef);
      stopMediaStream(mediaStreamRef.current);
      if (audioBlob.size <= 0) {
        if (isMountedRef.current) {
          setDictationState("idle");
        }
        return;
      }

      const sessionId = await ensureWritableSessionId();
      const transcription = await transcribeChatAudio(audioBlob, sessionId, t);
      if (isMountedRef.current) {
        acceptServerSessionId(transcription.sessionId);
        setInputText((currentText) => {
          const insertionResult = insertDictationTranscriptIntoDraft(
            currentText,
            transcription.text,
            draftSelectionRef.current,
          );
          const nextSelection = shouldRestoreTextareaFocusAfterDictationRef.current
            ? insertionResult.selection
            : null;
          draftSelectionRef.current = nextSelection;
          pendingTextareaSelectionRef.current = nextSelection;
          return insertionResult.text;
        });
      }
    } catch (error) {
      if (isMountedRef.current) {
        alert(getMicrophoneErrorMessage(error, t));
      }
    } finally {
      cleanupDictationResources(mediaRecorderRef, mediaStreamRef, recordedChunksRef);
      if (isMountedRef.current) {
        setDictationState("idle");
      }
    }
  }, [acceptServerSessionId, ensureWritableSessionId, t]);

  const handleToggleDictation = useCallback(async (): Promise<void> => {
    if (dictationState === "recording") {
      await stopDictation();
      return;
    }

    if (dictationState !== "idle") {
      return;
    }

    await startDictation();
  }, [dictationState, startDictation, stopDictation]);

  const sendPendingMessage = useCallback(async (): Promise<void> => {
    if (!canSendPendingMessage || isAttachmentProcessingRef.current) {
      return;
    }

    const nextText = inputText;
    const nextAttachments = pendingAttachments;
    setInputText("");
    setPendingAttachments([]);

    await sendMessage({
      text: nextText,
      attachments: nextAttachments,
    });
  }, [canSendPendingMessage, inputText, pendingAttachments, sendMessage]);

  const handleCopyTranscript = useCallback(async (): Promise<void> => {
    try {
      const { markdown } = await buildChatTranscriptMarkdown({
        messages,
        runState,
        exportedAt: Date.now(),
        t: (key, params) => t(key, params),
      });
      await navigator.clipboard.writeText(markdown);
      setCopyStatus("success");
    } catch {
      setCopyStatus("error");
    }

    if (copyStatusResetRef.current !== null) {
      clearTimeout(copyStatusResetRef.current);
    }
    copyStatusResetRef.current = setTimeout(() => {
      setCopyStatus("idle");
      copyStatusResetRef.current = null;
    }, 1500);
  }, [messages, runState, t]);

  const handleClearConversation = useCallback((): void => {
    discardDictation();
    textareaRef.current?.focus();
    void clearConversation();
  }, [clearConversation, discardDictation]);

  const copyButtonLabel = copyStatus === "success"
    ? t("chat.copied")
    : copyStatus === "error"
      ? t("chat.copyFailed")
      : t("chat.copyTranscript");
  const transcriptActionsDisabled = !isHistoryLoaded || messages.length === 0;
  const dictationStatusLabel = dictationState === "requesting_permission"
    ? t("chat.dictationWaitingPermission")
    : dictationState === "recording"
      ? t("chat.dictationRecording")
      : dictationState === "transcribing"
        ? t("chat.dictationTranscribing")
        : null;

  const rootClass = mode === "sidebar" ? styles.sidebar : styles.sidebarFullscreen;
  const sidebarStyle = mode === "sidebar" ? { width: localWidth } : undefined;

  return (
    <div
      className={rootClass}
      data-testid="chat-panel"
      style={sidebarStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={(e) => void handleDrop(e)}
    >
      {isDragOver && composerCapabilities.isDropTargetEnabled && (
        <div className={styles.dropOverlay} data-testid="chat-drop-overlay">
          {t("chat.dropFiles")}
        </div>
      )}
      {mode === "sidebar" && (
        <div
          className={cn(styles.resizeHandle, isDragging ? styles.resizeHandleDragging : "")}
          onMouseDown={(e) => { e.preventDefault(); setIsDragging(true); }}
        />
      )}
      <ChatPanelHeader
        mode={mode}
        transcriptActionsDisabled={transcriptActionsDisabled}
        copyButtonLabel={copyButtonLabel}
        onCopyTranscript={() => void handleCopyTranscript()}
        onClearConversation={handleClearConversation}
        onCloseSidebar={() => setIsOpen(false)}
      />
      <ChatTranscript
        messages={messages}
        isAssistantRunActive={isAssistantRunActive}
        isLiveStreamConnected={isLiveStreamConnected}
      />
      <ChatComposer
        inputText={inputText}
        pendingAttachments={pendingAttachments}
        attachmentErrors={attachmentErrors}
        isAttachmentProcessing={isAttachmentProcessing}
        composerAction={composerAction}
        dictationState={dictationState}
        dictationStatusLabel={dictationStatusLabel}
        capabilities={composerCapabilities}
        textareaRef={textareaRef}
        onInputChange={setInputText}
        onIngestFiles={ingestFiles}
        onRemoveAttachment={removeAttachment}
        onToggleDictation={handleToggleDictation}
        onSend={sendPendingMessage}
        onStop={stopMessage}
      />
    </div>
  );
};
